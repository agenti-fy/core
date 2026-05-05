import type { Logger } from 'pino';
import {
  normalizeIssueLabels,
  parseDependencies,
  parseRepo,
  type Method,
  type PersonaType,
} from '@agentify/shared';
import type { CoordinatorStore } from '../store.js';
import type { GitHubClient } from '../github/client.js';
import { hasHaltLabel, parseRoutingLabels } from './labels.js';

interface IssueLike {
  number: number;
  body?: string | null | undefined;
  labels: ReadonlyArray<string | { name?: string }> | undefined;
  /**
   * Set on PRs (Octokit's listForRepo returns both issues and PRs; PRs carry
   * a `pull_request` sub-object). Used to exempt PRs from the dep-gate —
   * deps are a pre-implementation concern, and once a PR is open the work
   * has already started.
   */
  pull_request?: unknown;
}

type EvalResult =
  | { kind: 'no-routing' }
  | { kind: 'blocked'; blockedBy: number }
  | { kind: 'ready'; items: PendingWorkItem[] };

/**
 * Evaluate one issue against routing rules + dep gate. Pure-ish (only the
 * dep-state lookup is async). Caller decides whether to dispatch, mark
 * blocked, or clear.
 *
 * Dep-gating applies to ISSUES only. PRs bypass it: a PR is the landing
 * mechanism for an already-implemented subtask; gating its review/merge
 * on the same deps the source issue had would lock review/merge behind
 * unrelated unmerged siblings, OR worse, behind prose in the PR body that
 * happens to contain a dep keyword ("after #N", "depends on", etc).
 */
async function evaluateIssue(
  issue: IssueLike,
  repo: string,
  fetchDepState: (n: number) => Promise<'open' | 'closed' | 'unknown'>,
  logger: Logger,
): Promise<EvalResult> {
  const labels = normalizeIssueLabels(issue.labels);
  const routings = parseRoutingLabels(labels);
  if (routings.length === 0) return { kind: 'no-routing' };

  const isPr = issue.pull_request !== undefined && issue.pull_request !== null;
  if (!isPr) {
    const deps = parseDependencies(issue.body ?? '');
    if (deps.length > 0) {
      for (const dep of deps) {
        if (dep === issue.number) continue;
        const state = await fetchDepState(dep);
        if (state === 'open') {
          logger.debug(
            { repo, target: issue.number, blocked_by: dep },
            'skipping target — dep still open',
          );
          return { kind: 'blocked', blockedBy: dep };
        }
      }
    }
  }

  const items: PendingWorkItem[] = routings.map((r) => ({
    repo,
    target_id: issue.number,
    persona: r.personaType,
    persona_name: r.persona,
    method: r.method,
  }));
  return { kind: 'ready', items };
}

export interface PendingWorkItem {
  repo: string;
  target_id: number;
  persona: PersonaType;
  /** Persona name as it appears in the label (custom souls preserve their raw name). */
  persona_name: string;
  method: Method;
}

export interface PollOutcome {
  items: PendingWorkItem[];
  haltSeen: boolean;
  /** Repos we successfully scanned this cycle. */
  scannedRepos: number;
  /** Repos we tried to scan (i.e. that were due). Helps distinguish "no halt" vs "couldn't see". */
  attemptedRepos: number;
  /** Issues we skipped because at least one declared dep was still open. */
  skippedByDeps: number;
}

/**
 * When the last full scan ran for a given repo (process-local). The
 * since=lastPolled filter is fast but invisible to items whose updated_at
 * doesn't move — items skipped because no agent was idle, items whose dep
 * cleared without bumping their own updated_at, etc. A periodic full scan
 * (no since= filter) picks them up.
 *
 * On boot the map is empty; the first poll per repo therefore forces a full
 * scan, which doubles as the previous "first poll since boot" recovery
 * mechanism. Subsequent full scans fire every FULL_SCAN_INTERVAL_MS.
 */
const lastFullScanAt = new Map<string, number>();
const FULL_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Repos to force a full scan on next tick. Set by the dispatcher when an
 * item is skipped due to no idle agent — those items would otherwise stay
 * invisible until the next periodic full scan (up to 10 min later) because
 * the since= filter excludes them. Once an agent becomes IDLE we want to
 * pick them up promptly.
 */
const pendingFullScanRepos = new Set<string>();

/** Public so dispatch can flag a repo when it skips an item due to no_agent. */
export function requestFullScanForRepo(repo: string): void {
  pendingFullScanRepos.add(repo);
}

/**
 * Scan repos due for polling (per-repo `poll_interval_s`). Only repos whose
 * last_polled is older than their cadence are visited; this lets per-repo
 * tuning actually take effect. Records `last_polled` on success.
 */
export async function pollDueRepos(
  github: GitHubClient,
  store: CoordinatorStore,
  logger: Logger,
): Promise<PollOutcome> {
  const repos = store.listReposDueForPoll();
  const items: PendingWorkItem[] = [];
  let haltSeen = false;
  let scanned = 0;
  let skippedByDeps = 0;

  // Per-repo polls run sequentially to keep GitHub rate-limit headroom predictable.
  for (const repoRow of repos) {
    // Capture poll start before the network call so a slow poll cycle doesn't
    // create a gap during which an issue update could be missed by the next
    // since= filter.
    const pollStartedAt = Date.now();

    // Force a full scan (no since= filter) on the first poll per repo since
    // process start AND every FULL_SCAN_INTERVAL_MS after that. Catches:
    //   - pre-existing items not yet tracked (boot recovery)
    //   - items skipped because no idle agent matched them
    //   - state changes that didn't bump the dependent's updated_at
    const lastFull = lastFullScanAt.get(repoRow.repo);
    const periodicDue =
      lastFull === undefined || pollStartedAt - lastFull >= FULL_SCAN_INTERVAL_MS;
    const dispatcherRequested = pendingFullScanRepos.has(repoRow.repo);
    const isDueForFullScan = periodicDue || dispatcherRequested;
    const effectiveLastPolled = isDueForFullScan ? null : repoRow.last_polled;
    if (isDueForFullScan && repoRow.last_polled !== null) {
      logger.info(
        {
          repo: repoRow.repo,
          isFirstSinceBoot: lastFull === undefined,
          dispatcherRequested,
        },
        'forcing full scan (no since= filter)',
      );
    }

    try {
      const result = await pollRepo(github, store, repoRow.repo, effectiveLastPolled, logger);
      items.push(...result.items);
      if (result.haltSeen) haltSeen = true;
      skippedByDeps += result.skippedByDeps;
      store.recordRepoPoll(repoRow.repo, pollStartedAt);
      if (isDueForFullScan) {
        lastFullScanAt.set(repoRow.repo, pollStartedAt);
        pendingFullScanRepos.delete(repoRow.repo);
      }
      scanned++;
    } catch (err) {
      logger.warn(
        { repo: repoRow.repo, err: err instanceof Error ? err.message : String(err) },
        'poll for repo failed',
      );
      // Record the failed poll too so we back off this repo for a full
      // poll_interval_s instead of hammering it every loop tick.
      store.recordRepoPoll(repoRow.repo, pollStartedAt);
      // Don't update lastFullScanAt on failure — next tick should retry the
      // full scan rather than waiting another interval.
    }
  }

  return {
    items,
    haltSeen,
    scannedRepos: scanned,
    attemptedRepos: repos.length,
    skippedByDeps,
  };
}

async function pollRepo(
  github: GitHubClient,
  store: CoordinatorStore,
  repo: string,
  lastPolledAt: number | null,
  logger: Logger,
): Promise<{ items: PendingWorkItem[]; haltSeen: boolean; skippedByDeps: number }> {
  const ref = parseRepo(repo);
  const owner = ref.owner;
  const name = ref.repo;
  const items: PendingWorkItem[] = [];
  let haltSeen = false;
  let skippedByDeps = 0;

  // Per-tick cache of dep-issue states. Avoids fetching issue #11 N times
  // when N siblings all `Depends on: #11`.
  const depStateCache = new Map<number, 'open' | 'closed'>();
  const fetchDepState = async (n: number): Promise<'open' | 'closed' | 'unknown'> => {
    const cached = depStateCache.get(n);
    if (cached) return cached;
    try {
      const { data } = await github.issues.get({ owner, repo: name, issue_number: n });
      const state = data.state === 'closed' ? 'closed' : 'open';
      depStateCache.set(n, state);
      return state;
    } catch (err) {
      // 404 means the dep doesn't exist — treat as unknown so we don't
      // gate routing on a typo. Operator owns dep correctness.
      logger.debug(
        { repo, dep: n, err: err instanceof Error ? err.message : String(err) },
        'dep lookup failed — treating as unknown',
      );
      return 'unknown';
    }
  };

  // 60s overlap so an issue updated mid-poll is still seen on the next cycle.
  // GitHub treats `since` as ">= updated_at" — the filter is conservative.
  const since =
    lastPolledAt !== null
      ? new Date(Math.max(0, lastPolledAt - 60_000)).toISOString()
      : undefined;

  // Track issue numbers visited via the since-filtered scan so the dep-blocked
  // re-check below doesn't refetch them.
  const seenInSinceLoop = new Set<number>();

  for await (const page of github.paginate.iterator(github.issues.listForRepo, {
    owner,
    repo: name,
    state: 'open',
    per_page: 100,
    ...(since !== undefined ? { since } : {}),
  })) {
    for (const issue of page.data) {
      seenInSinceLoop.add(issue.number);

      const labels = normalizeIssueLabels(issue.labels);
      if (hasHaltLabel(labels)) haltSeen = true;

      const result = await evaluateIssue(issue, repo, fetchDepState, logger);
      if (result.kind === 'blocked') {
        store.markDepBlocked(repo, issue.number);
        skippedByDeps++;
      } else if (result.kind === 'ready') {
        // If this issue was previously dep-blocked, deps are now resolved.
        store.clearDepBlocked(repo, issue.number);
        items.push(...result.items);
      } else {
        // No routing labels — clear any stale dep_blocked entry (skill
        // removed labels, operator relabeled, etc.).
        store.clearDepBlocked(repo, issue.number);
      }
    }
  }

  // The since= filter only returns issues whose updated_at moved. When a dep
  // PR merges and closes its linked issue, the DEPENDENT's updated_at doesn't
  // change — so without an explicit re-check, unblocked dependents stay
  // invisible to the poller. Iterate every previously-skipped target by
  // number and re-evaluate.
  const blockedNumbers = store.listDepBlockedForRepo(repo);
  for (const targetId of blockedNumbers) {
    if (seenInSinceLoop.has(targetId)) continue;

    let issue: IssueLike & { state: string };
    try {
      const { data } = await github.issues.get({
        owner,
        repo: name,
        issue_number: targetId,
      });
      issue = {
        number: data.number,
        body: data.body,
        labels: data.labels,
        state: data.state,
        pull_request: data.pull_request,
      };
    } catch (err) {
      // 404 / perm error — issue is gone or inaccessible. Drop the entry so
      // we don't keep retrying it forever.
      logger.debug(
        { repo, target: targetId, err: err instanceof Error ? err.message : String(err) },
        'dep-blocked re-check fetch failed — clearing entry',
      );
      store.clearDepBlocked(repo, targetId);
      continue;
    }

    if (issue.state === 'closed') {
      store.clearDepBlocked(repo, targetId);
      continue;
    }

    const result = await evaluateIssue(issue, repo, fetchDepState, logger);
    if (result.kind === 'blocked') {
      // Still blocked — leave the entry; refresh blocked_at for diagnostics.
      store.markDepBlocked(repo, targetId);
      skippedByDeps++;
    } else if (result.kind === 'ready') {
      store.clearDepBlocked(repo, targetId);
      items.push(...result.items);
      logger.info(
        { repo, target: targetId, routings: result.items.length },
        'dep-blocked target unblocked — routing',
      );
    } else {
      // No routing labels anymore — drop the entry.
      store.clearDepBlocked(repo, targetId);
    }
  }

  logger.debug(
    { repo, found: items.length, haltSeen, skippedByDeps },
    'repo scan complete',
  );
  return { items, haltSeen, skippedByDeps };
}
