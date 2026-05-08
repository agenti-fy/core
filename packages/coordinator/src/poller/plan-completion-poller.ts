import type { Logger } from 'pino';
import { parseRepo } from '@agenti-fy/shared';
import type { CoordinatorStore } from '../store.js';
import type { GitHubClient } from '../github/client.js';

export interface PlanCompletionOutcome {
  scannedPlans: number;
  updatedBodies: number;
  closedParents: number;
}

/**
 * Scan all open plans, update parent issue body checklists, and close parents
 * whose every child is closed.
 *
 * Per-plan failures are isolated — a bad GitHub call for one plan does not
 * abort the rest of the scan.
 */
export async function scanPlansForCompletion(
  github: GitHubClient,
  store: CoordinatorStore,
  logger: Logger,
): Promise<PlanCompletionOutcome> {
  const plans = store.listOpenPlans();
  let scannedPlans = 0;
  let updatedBodies = 0;
  let closedParents = 0;

  for (const plan of plans) {
    scannedPlans++;
    let ref;
    try {
      ref = parseRepo(plan.repo);
    } catch {
      logger.warn({ repo: plan.repo }, 'plan-completion-poller: invalid repo — skipping');
      continue;
    }

    try {
      // Fetch parent issue first to get current body + state.
      let parentIssue;
      try {
        const { data } = await github.issues.get({
          owner: ref.owner,
          repo: ref.repo,
          issue_number: plan.parent_id,
        });
        parentIssue = data;
      } catch (err) {
        logger.warn(
          {
            repo: plan.repo,
            parent_id: plan.parent_id,
            err: err instanceof Error ? err.message : String(err),
          },
          'plan-completion-poller: failed to fetch parent issue — skipping plan',
        );
        store.recordPlanCheck(plan.repo, plan.parent_id);
        continue;
      }

      const parentAlreadyClosed = parentIssue.state === 'closed';

      // Fetch each child's state; cache within this tick.
      const childStateCache = new Map<number, 'open' | 'closed'>();
      for (const childId of plan.child_ids) {
        try {
          const { data } = await github.issues.get({
            owner: ref.owner,
            repo: ref.repo,
            issue_number: childId,
          });
          childStateCache.set(childId, data.state as 'open' | 'closed');
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 404) {
            logger.warn(
              { repo: plan.repo, parent_id: plan.parent_id, child_id: childId },
              'plan-completion-poller: child issue 404 — treating as closed',
            );
            childStateCache.set(childId, 'closed');
          } else {
            logger.warn(
              {
                repo: plan.repo,
                parent_id: plan.parent_id,
                child_id: childId,
                err: err instanceof Error ? err.message : String(err),
              },
              'plan-completion-poller: failed to fetch child issue — treating as open',
            );
            childStateCache.set(childId, 'open');
          }
        }
      }

      // If the parent is already closed, mark complete and move on — no body
      // edit, no comment.
      if (parentAlreadyClosed) {
        store.markPlanComplete(plan.repo, plan.parent_id);
        store.recordPlanCheck(plan.repo, plan.parent_id);
        continue;
      }

      const childIdSet = new Set(plan.child_ids);
      const allClosed =
        plan.child_ids.length > 0 &&
        plan.child_ids.every((id) => childStateCache.get(id) === 'closed');

      // Rewrite body checklist if anything changed.
      const currentBody = parentIssue.body ?? '';
      const newBody = rewriteChecklist(currentBody, childIdSet, childStateCache);
      if (newBody !== currentBody) {
        try {
          await github.issues.update({
            owner: ref.owner,
            repo: ref.repo,
            issue_number: plan.parent_id,
            body: newBody,
          });
          updatedBodies++;
        } catch (err) {
          logger.warn(
            {
              repo: plan.repo,
              parent_id: plan.parent_id,
              err: err instanceof Error ? err.message : String(err),
            },
            'plan-completion-poller: failed to update parent body',
          );
        }
      }

      if (allClosed) {
        const closedList = plan.child_ids.map((id) => `#${id}`).join(', ');
        const commentBody =
          `🎯 **The Orchestrator** · Project Manager — auto-closing tracking issue: all planned subtasks complete.\n\n` +
          `Closed subtasks: ${closedList}`;

        try {
          await github.issues.createComment({
            owner: ref.owner,
            repo: ref.repo,
            issue_number: plan.parent_id,
            body: commentBody,
          });
        } catch (err) {
          logger.warn(
            {
              repo: plan.repo,
              parent_id: plan.parent_id,
              err: err instanceof Error ? err.message : String(err),
            },
            'plan-completion-poller: failed to post closing comment',
          );
        }

        try {
          await github.issues.update({
            owner: ref.owner,
            repo: ref.repo,
            issue_number: plan.parent_id,
            state: 'closed',
            state_reason: 'completed',
          });
          store.markPlanComplete(plan.repo, plan.parent_id);
          closedParents++;
        } catch (err) {
          logger.warn(
            {
              repo: plan.repo,
              parent_id: plan.parent_id,
              err: err instanceof Error ? err.message : String(err),
            },
            'plan-completion-poller: failed to close parent issue',
          );
        }
      }

      store.recordPlanCheck(plan.repo, plan.parent_id);
    } catch (err) {
      logger.warn(
        {
          repo: plan.repo,
          parent_id: plan.parent_id,
          err: err instanceof Error ? err.message : String(err),
        },
        'plan-completion-poller: plan scan failed',
      );
    }
  }

  return { scannedPlans, updatedBodies, closedParents };
}

/**
 * Rewrite only the checklist lines in `body` that correspond to known child
 * IDs. All other lines are returned verbatim.
 *
 * Matches lines of the form: `  - [ ] #N` or `  - [x] #N optional text`
 * Sets `[x]` when the child is closed, `[ ]` when open.
 */
function rewriteChecklist(
  body: string,
  childIds: Set<number>,
  childStates: Map<number, 'open' | 'closed'>,
): string {
  return body
    .split('\n')
    .map((line) => {
      const m = /^(\s*-\s*)\[\s*[ xX]?\s*\] (#(\d+))( .*)?$/.exec(line);
      if (!m) return line;
      const issueNum = parseInt(m[3]!, 10);
      if (!childIds.has(issueNum)) return line;
      const marker = childStates.get(issueNum) === 'closed' ? '[x]' : '[ ]';
      return `${m[1]}${marker} ${m[2]}${m[4] ?? ''}`;
    })
    .join('\n');
}
