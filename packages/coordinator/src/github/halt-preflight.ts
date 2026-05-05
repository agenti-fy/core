import type { Logger } from 'pino';
import { HALT_LABEL } from '@agentify/shared';
import type { GitHubClient } from './client.js';

/**
 * One-shot: ask GitHub's search API if any open issue across the App's
 * accessible repos currently carries the `halt-agents` label. The work
 * poller's `since=` filter blinds it to halt labels on stale issues — so
 * after a coordinator restart, that filter would silently miss a halt that
 * was applied long ago. This preflight runs once at startup before the work
 * poller, fixing that gap.
 *
 * The search API has its own rate limit (30 authenticated req/min). One call
 * per coordinator boot is fine. Failures are non-fatal — we log and continue
 * (worst case: halt detection waits for the operator to bump the issue).
 */
export async function checkHaltLabelAtStartup(
  github: GitHubClient,
  logger: Logger,
): Promise<boolean> {
  try {
    const res = await github.search.issuesAndPullRequests({
      q: `label:"${HALT_LABEL}" is:open`,
      per_page: 1,
    });
    const total = res.data.total_count;
    if (total > 0) {
      logger.warn(
        { total, sample: res.data.items[0]?.html_url },
        'startup halt preflight: halt-agents label observed',
      );
      return true;
    }
    return false;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'startup halt preflight failed (non-fatal); halt detection deferred to next poll',
    );
    return false;
  }
}
