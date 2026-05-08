import type { Logger } from 'pino';
import {
  isBuiltinPersona,
  NEEDS_HUMAN_LABEL,
  normalizeIssueLabels,
  parseRepo,
  parseRoutingLabel,
  routingLabel,
  type Method,
} from '@agenti-fy/shared';
import type { CoordinatorStore } from '../store.js';
import type { GitHubClient } from '../github/client.js';

/**
 * Coordinator-side PR review state machine.
 *
 * Replaces the previous "model writes its own routing labels" approach with
 * a deterministic monitor that watches PR state and applies the right next
 * routing label every tick. Skills no longer think about what comes next —
 * they do their work, the runner removes the in-progress marker, and the
 * monitor decides whether to add `agent:<author>:address-review`,
 * `agent:conductor:merge`, or re-add reviewer labels.
 *
 * Routing rules (computed per PR every tick):
 *   1. `needs-human` set → operator owns it; no auto-routing.
 *   2. Any required reviewer has `CHANGES_REQUESTED` on current HEAD →
 *      route to `agent:<author-persona>:address-review`. Remove reviewer
 *      labels (their reviews of soon-to-be-stale code aren't useful).
 *   3. All required reviewers have `APPROVED` on current HEAD →
 *      route to `agent:conductor:merge`.
 *   4. Otherwise → for each required reviewer who hasn't approved or
 *      requested changes on the current HEAD (none, stale, or COMMENTED),
 *      ensure `agent:<reviewer>:review` is set.
 *
 * Cross-cutting: any (persona, method) currently in-progress is excluded
 * from the desired set — the agent's runner owns that lifecycle. The
 * monitor only edits dispatchable routing labels.
 */

export interface PrMonitorConfig {
  requiredReviewers: readonly string[];
  /** Max number of re-review cycles after the initial review. Default: 5. */
  maxReviewCycles: number;
}

export interface ReviewSnapshot {
  /** Persona derived from review author's bot login (e.g. `agenti-fy-skeptic[bot]` → `skeptic`). Null for human reviewers. */
  authorPersona: string | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  commitId: string;
  submittedAt: string;
}

export interface PrSnapshot {
  number: number;
  /** Persona derived from PR author's bot login. Null for non-agent (human-opened) PRs. */
  authorPersona: string | null;
  headSha: string;
  labels: readonly string[];
  reviews: readonly ReviewSnapshot[];
}

export interface MonitorOutcome {
  scannedRepos: number;
  scannedPrs: number;
  /** PRs whose label set was changed this tick. */
  routed: number;
}

/**
 * Whether the PR monitor should dispatch a new review label for a given persona.
 *
 * The filter exists to avoid spurious duplicate review jobs when only labels
 * or metadata changed on a PR whose code (HEAD SHA) is unchanged. It must NOT
 * fire when the persona was labeled previously but never actually completed a
 * review on this HEAD — that means the prior dispatch failed (hijack flag,
 * agent crash, /reset, container restart, etc.) and re-dispatch is exactly
 * what an operator clearing `needs-human` and re-adding the label is asking
 * for. Earlier versions ignored this case and silently re-suppressed any
 * manually-restored review label within the next pr-monitor tick.
 *
 * Suppress (return false) only when ALL of:
 *   1. We have a recorded last-labeled SHA for this persona.
 *   2. That SHA equals the current HEAD.
 *   3. The persona has a non-dismissed verdict (APPROVED / CHANGES_REQUESTED /
 *      COMMENTED) on the current HEAD — i.e. they actually ran.
 *   4. They do NOT have a stale CHANGES_REQUESTED on an older commit (which
 *      would mean the author addressed feedback without bumping HEAD and the
 *      reviewer should re-examine).
 *
 * Exported for testing.
 */
export function shouldDispatchReviewLabel(
  persona: string,
  snapshot: PrSnapshot,
  lastLabeledSha: string | null,
): boolean {
  if (lastLabeledSha === null) return true;
  if (snapshot.headSha !== lastLabeledSha) return true;

  const hasCurrentVerdict = snapshot.reviews.some(
    (r) =>
      r.authorPersona === persona &&
      r.commitId === snapshot.headSha &&
      r.state !== 'DISMISSED' &&
      r.state !== 'PENDING',
  );
  // No verdict on current HEAD → previous dispatch never produced a review;
  // allow re-dispatch (this is the recovery path after needs-human clears).
  if (!hasCurrentVerdict) return true;

  // Verdict exists on current HEAD. Allow re-dispatch only if the persona
  // also has a stale CHANGES_REQUESTED on an older commit (author addressed
  // it via reply / dismissal of stale review without bumping HEAD).
  return snapshot.reviews.some(
    (r) =>
      r.authorPersona === persona &&
      r.state === 'CHANGES_REQUESTED' &&
      r.commitId !== snapshot.headSha,
  );
}

/**
 * Compute the desired routing labels (dispatchable form only) for a PR.
 *
 * Pure function; the caller diffs against the current label set and applies
 * via `setLabels`. Returns null when the monitor should leave the PR alone
 * entirely (e.g. `needs-human`).
 */
export function desiredRoutingLabels(
  pr: PrSnapshot,
  config: PrMonitorConfig,
): string[] | null {
  // Operator-owned: hands off completely.
  if (pr.labels.includes(NEEDS_HUMAN_LABEL)) return null;

  // Build the in-progress key set so we never re-add a label whose work is
  // already in flight. Key form: "<persona>:<method-slug>".
  const inProgressKeys = new Set<string>();
  for (const lbl of pr.labels) {
    const parsed = parseRoutingLabel(lbl);
    if (parsed?.inProgress) {
      inProgressKeys.add(`${parsed.persona}:${parsed.method}`);
    }
  }
  const isInProgress = (persona: string, method: Method): boolean =>
    inProgressKeys.has(`${persona}:${method}`);

  // Reviewers who SHOULD review: required minus the author (no
  // self-review). For human-opened PRs (author null), every required
  // reviewer is a candidate.
  const reviewers = config.requiredReviewers.filter(
    (r) => r !== pr.authorPersona && isBuiltinPersona(r),
  );

  type ReviewerState = 'open' | 'approved' | 'changes_requested';
  const stateOf = (reviewer: string): ReviewerState => {
    // Latest non-dismissed verdict on the CURRENT HEAD by this reviewer.
    // Prior reviews on stale commits don't count — author moved past them.
    let latest: ReviewSnapshot | null = null;
    for (const r of pr.reviews) {
      if (r.authorPersona !== reviewer) continue;
      if (r.commitId !== pr.headSha) continue;
      if (r.state === 'DISMISSED' || r.state === 'PENDING') continue;
      if (!latest || r.submittedAt > latest.submittedAt) latest = r;
    }
    if (!latest) return 'open';
    if (latest.state === 'APPROVED') return 'approved';
    if (latest.state === 'CHANGES_REQUESTED') return 'changes_requested';
    // COMMENTED on current HEAD — the reviewer is an agent (only agent
    // personas appear in `reviewers`), they ran, looked, and chose not to
    // block. Treat as approval-by-abstention so the merge gate fires.
    // Earlier behavior treated this as 'open', which deadlocked any PR
    // where a required reviewer produced an out-of-lane COMMENT (e.g.
    // skeptic on a docs-only PR — review.md previously instructed
    // "stay in your lane → comment briefly").
    // The corresponding skill prompt now requires APPROVE for out-of-lane,
    // but this behavior also unblocks PRs that already have a terminal
    // COMMENTED review.
    return 'approved';
  };

  const states = new Map<string, ReviewerState>();
  for (const r of reviewers) states.set(r, stateOf(r));
  const anyChanges = [...states.values()].some((s) => s === 'changes_requested');
  const allApproved =
    reviewers.length > 0 && [...states.values()].every((s) => s === 'approved');

  // CHANGES_REQUESTED on current HEAD → route to address-review. Other
  // reviewers' reviews of about-to-be-stale code aren't useful; clear them.
  if (anyChanges) {
    // Author isn't an agent — leave alone, can't auto-route. (Operator
    // notices via the CHANGES_REQUESTED review and handles manually.)
    if (!pr.authorPersona) return [];
    if (isInProgress(pr.authorPersona, 'address_review')) return [];
    return [routingLabel(pr.authorPersona, 'address_review')];
  }

  // All required reviewers approved on current HEAD → merge gate.
  if (allApproved) {
    if (isInProgress('conductor', 'merge')) return [];
    return [routingLabel('conductor', 'merge')];
  }

  // Otherwise: ensure a review label for every reviewer whose verdict
  // isn't current on this HEAD.
  const out: string[] = [];
  for (const [reviewer, state] of states) {
    if (state !== 'open') continue;
    if (isInProgress(reviewer, 'review')) continue;
    out.push(routingLabel(reviewer, 'review'));
  }
  return out;
}

/**
 * Strip both `agent:*` routing labels (dispatchable) and in-progress
 * markers from a label set, returning the rest. Used to compute the
 * "preserve-as-is" tail when applying the monitor's diff.
 */
function nonRoutingLabels(labels: readonly string[]): string[] {
  return labels.filter((l) => parseRoutingLabel(l) === null);
}

/** All `*-in-progress` markers on the PR — preserved across monitor edits. */
function inProgressMarkers(labels: readonly string[]): string[] {
  return labels.filter((l) => {
    const p = parseRoutingLabel(l);
    return p?.inProgress === true;
  });
}

/**
 * Parse the persona from an agent-bot login. App slugs follow
 * `<prefix>-<persona>[bot]`. Returns null if the login doesn't match the
 * pattern OR if the captured persona isn't a recognized built-in.
 */
function personaFromLogin(login: string | null | undefined): string | null {
  if (!login) return null;
  const m = /^[A-Za-z0-9-]+-([a-z][a-z-]*)\[bot\]$/.exec(login);
  if (!m || !m[1]) return null;
  const candidate = m[1];
  return isBuiltinPersona(candidate) ? candidate : null;
}

/**
 * Walk every active repo's open PRs and apply the desired routing diff.
 */
export async function monitorPullRequests(
  github: GitHubClient,
  store: CoordinatorStore,
  config: PrMonitorConfig,
  logger: Logger,
): Promise<MonitorOutcome> {
  const repos = store.listRepos().filter((r) => r.active);
  let scannedRepos = 0;
  let scannedPrs = 0;
  let routed = 0;

  for (const repoRow of repos) {
    let ref;
    try {
      ref = parseRepo(repoRow.repo);
    } catch {
      continue;
    }
    try {
      for await (const page of github.paginate.iterator(github.pulls.list, {
        owner: ref.owner,
        repo: ref.repo,
        state: 'open',
        per_page: 100,
      })) {
        for (const pr of page.data) {
          scannedPrs++;
          // Reviews aren't included in the list response — fetch separately.
          // O(N) per tick on N open PRs. Acceptable for typical N (< 100);
          // can move to GraphQL if it ever isn't.
          let reviewsRaw;
          try {
            const { data } = await github.pulls.listReviews({
              owner: ref.owner,
              repo: ref.repo,
              pull_number: pr.number,
              per_page: 100,
            });
            reviewsRaw = data;
          } catch (err) {
            logger.warn(
              {
                repo: repoRow.repo,
                pr: pr.number,
                err: err instanceof Error ? err.message : String(err),
              },
              'pr-monitor: listReviews failed — skipping this PR',
            );
            continue;
          }

          const reviews: ReviewSnapshot[] = reviewsRaw.map((r) => ({
            authorPersona: personaFromLogin(r.user?.login),
            state: (r.state ?? 'COMMENTED') as ReviewSnapshot['state'],
            commitId: r.commit_id ?? '',
            submittedAt: r.submitted_at ?? '',
          }));
          const labels = normalizeIssueLabels(pr.labels);
          const snapshot: PrSnapshot = {
            number: pr.number,
            authorPersona: personaFromLogin(pr.user?.login),
            headSha: pr.head?.sha ?? '',
            labels,
            reviews,
          };

          const desired = desiredRoutingLabels(snapshot, config);
          if (desired === null) {
            logger.debug(
              { repo: repoRow.repo, pr: pr.number, reason: 'needs-human' },
              'pr-monitor: hands-off',
            );
            continue;
          }

          // SHA filter: suppress reviewer labels whose HEAD SHA is unchanged
          // since the last dispatch (prevents spurious duplicate review jobs
          // when only labels/metadata changed on the PR).
          const filtered = desired.filter((label) => {
            const parsed = parseRoutingLabel(label);
            if (!parsed || parsed.method !== 'review' || parsed.inProgress) return true;
            const lastSha = store.getLastLabeledSha(
              repoRow.repo,
              snapshot.number,
              parsed.persona,
            );
            return shouldDispatchReviewLabel(parsed.persona, snapshot, lastSha);
          });

          // Build the next label set: non-routing + in-progress markers + filtered routing.
          const next = new Set<string>([
            ...nonRoutingLabels(labels),
            ...inProgressMarkers(labels),
            ...filtered,
          ]);
          // Diff: only call setLabels if the routing portion actually changed.
          const currentRouting = new Set(
            labels.filter((l) => {
              const p = parseRoutingLabel(l);
              return p !== null && !p.inProgress;
            }),
          );
          const filteredSet = new Set(filtered);
          if (
            currentRouting.size === filteredSet.size &&
            [...currentRouting].every((l) => filteredSet.has(l))
          ) {
            logger.debug(
              {
                repo: repoRow.repo,
                pr: pr.number,
                author: snapshot.authorPersona,
                head: snapshot.headSha.slice(0, 7),
                current: [...currentRouting],
                reviewCount: reviews.length,
              },
              'pr-monitor: no-op (current matches desired)',
            );
            continue;
          }

          // Identify reviewer labels that are genuinely new (not already present).
          const newReviewLabels = filtered.filter((l) => {
            const p = parseRoutingLabel(l);
            return p?.method === 'review' && !p.inProgress && !currentRouting.has(l);
          });

          // Cycle cap: if this is a re-dispatch (not the first time we're
          // sending review labels for this PR), check whether we've hit the
          // configured limit and switch to needs-human if so.
          if (newReviewLabels.length > 0) {
            const isFirstReview = !store.hasAnyLabeledSha(repoRow.repo, snapshot.number);
            if (!isFirstReview) {
              const count = store.getReviewCycleCount(repoRow.repo, snapshot.number);
              if (count >= config.maxReviewCycles) {
                logger.warn(
                  {
                    repo: repoRow.repo,
                    pr: pr.number,
                    cycleCount: count,
                    maxReviewCycles: config.maxReviewCycles,
                  },
                  'pr-monitor: review cycle cap reached — applying needs-human',
                );
                const capNext = [
                  ...nonRoutingLabels(labels),
                  ...inProgressMarkers(labels),
                  NEEDS_HUMAN_LABEL,
                ];
                try {
                  await github.issues.setLabels({
                    owner: ref.owner,
                    repo: ref.repo,
                    issue_number: pr.number,
                    labels: capNext,
                  });
                  await github.issues.createComment({
                    owner: ref.owner,
                    repo: ref.repo,
                    issue_number: pr.number,
                    body:
                      `⚠️ **Automated review-cycle cap reached** (${config.maxReviewCycles} re-review cycles).\n\n` +
                      `This PR has gone through the maximum number of automated review → address-review iterations. ` +
                      `A human must take over to resolve the outstanding review feedback.\n\n` +
                      `*Set by the PR monitor (PR_MAX_REVIEW_CYCLES=${config.maxReviewCycles}).*`,
                  });
                  routed++;
                } catch (err) {
                  logger.warn(
                    {
                      repo: repoRow.repo,
                      pr: pr.number,
                      err: err instanceof Error ? err.message : String(err),
                    },
                    'pr-monitor: cap setLabels/createComment failed',
                  );
                }
                continue;
              }
            }
          }

          try {
            await github.issues.setLabels({
              owner: ref.owner,
              repo: ref.repo,
              issue_number: pr.number,
              labels: [...next],
            });
            routed++;

            // After successful dispatch: record SHA + increment cycle counter.
            if (newReviewLabels.length > 0) {
              const isFirstReview = !store.hasAnyLabeledSha(repoRow.repo, snapshot.number);
              for (const label of newReviewLabels) {
                const parsed = parseRoutingLabel(label)!;
                store.recordLabeledSha(
                  repoRow.repo,
                  snapshot.number,
                  parsed.persona,
                  snapshot.headSha,
                );
              }
              if (!isFirstReview) {
                store.incrementReviewCycleCount(repoRow.repo, snapshot.number);
              }
            }

            logger.info(
              {
                repo: repoRow.repo,
                pr: pr.number,
                added: [...filteredSet].filter((l) => !currentRouting.has(l)),
                removed: [...currentRouting].filter((l) => !filteredSet.has(l)),
              },
              'pr-monitor: routed',
            );
          } catch (err) {
            logger.warn(
              {
                repo: repoRow.repo,
                pr: pr.number,
                err: err instanceof Error ? err.message : String(err),
              },
              'pr-monitor: setLabels failed',
            );
          }
        }
      }
      scannedRepos++;
    } catch (err) {
      logger.warn(
        { repo: repoRow.repo, err: err instanceof Error ? err.message : String(err) },
        'pr-monitor: repo scan failed',
      );
    }
  }

  return { scannedRepos, scannedPrs, routed };
}

// Visible for testing.
export const __test = { personaFromLogin, nonRoutingLabels, inProgressMarkers };
