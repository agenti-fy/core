import type { Logger } from 'pino';
import {
  inProgressLabel,
  normalizeIssueLabels,
  parseRepo,
  parseRoutingLabel,
  routingLabel,
} from '@agentify/shared';
import type { CoordinatorStore } from '../store.js';
import type { GitHubClient } from '../github/client.js';

export interface SweepOutcome {
  scannedRepos: number;
  scannedIssues: number;
  swept: number;
}

/**
 * Find issues stuck with an `agent:<persona>:<method>-in-progress` label
 * whose `updated_at` is older than `staleTimeoutMs` AND whose corresponding
 * (persona, method, target) has no active job in the DB (i.e. the agent
 * crashed mid-run, was deleted, etc.). Restore the routing label so the
 * work-poller re-dispatches.
 *
 * Per-persona scoped: each in-progress marker is treated independently.
 * If conductor's review is stuck and skeptic's review is in-flight on the
 * same PR, only conductor's gets swept.
 *
 * Cost: a full open-issue scan per active repo per sweep cycle. Run on a slow
 * cadence (default 10 min) — this is a janitor, not a hot path.
 */
export async function sweepStaleInProgress(
  github: GitHubClient,
  store: CoordinatorStore,
  staleTimeoutMs: number,
  logger: Logger,
): Promise<SweepOutcome> {
  const repos = store.listRepos().filter((r) => r.active);
  const now = Date.now();
  let scannedRepos = 0;
  let scannedIssues = 0;
  let swept = 0;

  for (const repoRow of repos) {
    let ref;
    try {
      ref = parseRepo(repoRow.repo);
    } catch {
      continue;
    }
    try {
      for await (const page of github.paginate.iterator(github.issues.listForRepo, {
        owner: ref.owner,
        repo: ref.repo,
        state: 'open',
        per_page: 100,
      })) {
        for (const issue of page.data) {
          scannedIssues++;
          const labels = normalizeIssueLabels(issue.labels);

          // An issue can carry MULTIPLE in-progress markers (one per
          // persona). Sweep each independently.
          const inProgressMarkers = labels
            .map(parseRoutingLabel)
            .filter((p): p is NonNullable<typeof p> => p !== null && p.inProgress);

          if (inProgressMarkers.length === 0) continue;

          const updatedAt =
            typeof issue.updated_at === 'string' ? Date.parse(issue.updated_at) : 0;
          if (!Number.isFinite(updatedAt) || now - updatedAt < staleTimeoutMs) continue;

          // Build the post-sweep label set in one pass: replace stuck
          // markers with their routing equivalents wherever the matching
          // (persona, method, target) has no active job.
          let next: string[] = [...labels];
          let mutated = false;
          for (const marker of inProgressMarkers) {
            if (
              store.hasActiveJob(
                repoRow.repo,
                marker.persona,
                marker.method,
                issue.number,
              )
            ) {
              continue; // healthy in-flight, leave alone
            }
            const stuck = inProgressLabel(marker.persona, marker.method);
            const restore = routingLabel(marker.persona, marker.method);
            next = next.filter((l) => l !== stuck);
            if (!next.includes(restore)) next.push(restore);
            mutated = true;
            logger.warn(
              {
                repo: repoRow.repo,
                issue: issue.number,
                cleared: stuck,
                restored: restore,
                age_s: Math.round((now - updatedAt) / 1000),
              },
              'sweeping stale in-progress label',
            );
          }

          if (!mutated) continue;

          try {
            await github.issues.setLabels({
              owner: ref.owner,
              repo: ref.repo,
              issue_number: issue.number,
              labels: next,
            });
            swept++;
          } catch (err) {
            logger.warn(
              {
                repo: repoRow.repo,
                issue: issue.number,
                err: err instanceof Error ? err.message : String(err),
              },
              'failed to apply sweep — labels reverted to in-progress will be retried next cycle',
            );
          }
        }
      }
      scannedRepos++;
    } catch (err) {
      logger.warn(
        { repo: repoRow.repo, err: err instanceof Error ? err.message : String(err) },
        'sweep scan failed for repo',
      );
    }
  }

  return { scannedRepos, scannedIssues, swept };
}
