import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';
import { CoordinatorStore } from '../store.js';
import { scanPlansForCompletion } from './plan-completion-poller.js';

const silentLog: Logger = pino({ level: 'silent' });

function freshStore(): CoordinatorStore {
  const dir = mkdtempSync(join(tmpdir(), 'agentify-plan-completion-'));
  return new CoordinatorStore(join(dir, 'test.db'));
}

type IssueState = 'open' | 'closed' | 404 | Error;

interface FakeIssueRow {
  state: IssueState;
  body?: string;
}

interface UpdateCall {
  issue_number: number;
  body: string | undefined;
  state: string | undefined;
  state_reason: string | undefined;
}

interface CommentCall {
  issue_number: number;
  body: string;
}

/**
 * Minimal GitHub mock. Stores issue state by number.
 * Tracks calls to `issues.update` and `issues.createComment` for assertions.
 */
class FakeGitHub {
  private issues_map = new Map<number, FakeIssueRow>();
  updateCalls: UpdateCall[] = [];
  commentCalls: CommentCall[] = [];

  setIssue(number: number, state: IssueState, body = ''): void {
    this.issues_map.set(number, { state, body });
  }

  get issues() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async get({ issue_number }: { owner: string; repo: string; issue_number: number }) {
        const row = self.issues_map.get(issue_number);
        if (!row) {
          const err = Object.assign(new Error('Not Found'), { status: 404 });
          throw err;
        }
        if (row.state === 404) {
          const err = Object.assign(new Error('Not Found'), { status: 404 });
          throw err;
        }
        if (row.state instanceof Error) throw row.state;
        return { data: { state: row.state, body: row.body ?? '' } };
      },
      async update(params: { owner: string; repo: string; issue_number: number; body?: string; state?: string; state_reason?: string }) {
        self.updateCalls.push({
          issue_number: params.issue_number,
          body: params.body,
          state: params.state,
          state_reason: params.state_reason,
        });
        // Reflect state change in map so subsequent reads are consistent.
        const row = self.issues_map.get(params.issue_number);
        if (row) {
          if (params.state) row.state = params.state as 'open' | 'closed';
          if (params.body !== undefined) row.body = params.body;
        }
      },
      async createComment(params: { owner: string; repo: string; issue_number: number; body: string }) {
        self.commentCalls.push({ issue_number: params.issue_number, body: params.body });
      },
    };
  }
}

const REPO = 'owner/test-repo';
const PARENT = 10;

describe('scanPlansForCompletion', () => {
  let store: CoordinatorStore;
  let gh: FakeGitHub;

  beforeEach(() => {
    store = freshStore();
    gh = new FakeGitHub();
  });

  it('returns zero counts when there are no open plans', async () => {
    const result = await scanPlansForCompletion(gh as never, store, silentLog);
    expect(result).toEqual({ scannedPlans: 0, updatedBodies: 0, closedParents: 0 });
  });

  it('all children open → no body change, no close', async () => {
    const body = '## Plan\n\n- [ ] #1\n- [ ] #2\n';
    gh.setIssue(PARENT, 'open', body);
    gh.setIssue(1, 'open');
    gh.setIssue(2, 'open');
    store.upsertPlan(REPO, PARENT, [1, 2]);

    const result = await scanPlansForCompletion(gh as never, store, silentLog);

    expect(result).toEqual({ scannedPlans: 1, updatedBodies: 0, closedParents: 0 });
    // No updates, no comments.
    expect(gh.updateCalls).toHaveLength(0);
    expect(gh.commentCalls).toHaveLength(0);
  });

  it('some children closed → body checklist updated, parent stays open', async () => {
    const body = '## Plan\n\n- [ ] #1\n- [ ] #2\n';
    gh.setIssue(PARENT, 'open', body);
    gh.setIssue(1, 'closed');
    gh.setIssue(2, 'open');
    store.upsertPlan(REPO, PARENT, [1, 2]);

    const result = await scanPlansForCompletion(gh as never, store, silentLog);

    expect(result).toEqual({ scannedPlans: 1, updatedBodies: 1, closedParents: 0 });
    expect(gh.commentCalls).toHaveLength(0);
    expect(gh.updateCalls).toHaveLength(1);
    expect(gh.updateCalls[0]).toMatchObject({
      issue_number: PARENT,
      body: '## Plan\n\n- [x] #1\n- [ ] #2\n',
    });
  });

  it('all children closed → comment posted, parent closed, plan marked complete', async () => {
    const body = '## Plan\n\n- [ ] #1\n- [ ] #2\n';
    gh.setIssue(PARENT, 'open', body);
    gh.setIssue(1, 'closed');
    gh.setIssue(2, 'closed');
    store.upsertPlan(REPO, PARENT, [1, 2]);

    const result = await scanPlansForCompletion(gh as never, store, silentLog);

    expect(result).toEqual({ scannedPlans: 1, updatedBodies: 1, closedParents: 1 });

    // Body update call.
    const bodyCall = gh.updateCalls.find((c) => c.body !== undefined && c.state === undefined);
    expect(bodyCall).toBeDefined();
    expect(bodyCall!.body).toBe('## Plan\n\n- [x] #1\n- [x] #2\n');

    // Closing comment.
    expect(gh.commentCalls).toHaveLength(1);
    expect(gh.commentCalls[0]!.issue_number).toBe(PARENT);
    expect(gh.commentCalls[0]!.body).toContain('🎯 **The Orchestrator**');
    expect(gh.commentCalls[0]!.body).toContain('auto-closing tracking issue');
    expect(gh.commentCalls[0]!.body).toContain('#1');
    expect(gh.commentCalls[0]!.body).toContain('#2');

    // State close call.
    const closeCall = gh.updateCalls.find((c) => c.state === 'closed');
    expect(closeCall).toBeDefined();
    expect(closeCall!.state_reason).toBe('completed');

    // Plan marked complete (falls out of listOpenPlans).
    const openPlans = store.listOpenPlans();
    expect(openPlans).toHaveLength(0);
  });

  it('parent already closed → markPlanComplete called, no comment, no body edit', async () => {
    const body = '## Plan\n\n- [ ] #1\n';
    gh.setIssue(PARENT, 'closed', body);
    gh.setIssue(1, 'open');
    store.upsertPlan(REPO, PARENT, [1]);

    const result = await scanPlansForCompletion(gh as never, store, silentLog);

    expect(result).toEqual({ scannedPlans: 1, updatedBodies: 0, closedParents: 0 });
    expect(gh.updateCalls).toHaveLength(0);
    expect(gh.commentCalls).toHaveLength(0);

    // Plan drained from open list.
    expect(store.listOpenPlans()).toHaveLength(0);
  });

  it('one child returns 404 → treated as closed', async () => {
    const body = '## Plan\n\n- [ ] #1\n- [ ] #2\n';
    gh.setIssue(PARENT, 'open', body);
    gh.setIssue(1, 404);
    gh.setIssue(2, 'closed');
    store.upsertPlan(REPO, PARENT, [1, 2]);

    const result = await scanPlansForCompletion(gh as never, store, silentLog);

    // Both children treated as closed → parent should close.
    expect(result.closedParents).toBe(1);
    expect(gh.commentCalls).toHaveLength(1);
  });

  it('body lines unrelated to children are preserved verbatim', async () => {
    const body = [
      '## Tracking Issue',
      '',
      'Some description here.',
      '',
      '- [ ] #1',
      '- [ ] #2',
      '',
      '> Note: manual note that should not be touched',
      '- unrelated list item',
    ].join('\n');

    gh.setIssue(PARENT, 'open', body);
    gh.setIssue(1, 'closed');
    gh.setIssue(2, 'open');
    store.upsertPlan(REPO, PARENT, [1, 2]);

    await scanPlansForCompletion(gh as never, store, silentLog);

    const updateCall = gh.updateCalls.find((c) => c.body !== undefined);
    expect(updateCall).toBeDefined();
    const newBody = updateCall!.body!;
    expect(newBody).toContain('## Tracking Issue');
    expect(newBody).toContain('Some description here.');
    expect(newBody).toContain('> Note: manual note that should not be touched');
    expect(newBody).toContain('- unrelated list item');
    expect(newBody).toContain('- [x] #1');
    expect(newBody).toContain('- [ ] #2');
  });

  it('checklist lines for IDs not in child_ids are left untouched', async () => {
    // #99 is in the body but NOT a registered child — it must not be flipped.
    const body = '- [ ] #1\n- [ ] #99\n';
    gh.setIssue(PARENT, 'open', body);
    gh.setIssue(1, 'closed');
    store.upsertPlan(REPO, PARENT, [1]); // only #1 is a registered child

    await scanPlansForCompletion(gh as never, store, silentLog);

    const updateCall = gh.updateCalls.find((c) => c.body !== undefined);
    expect(updateCall).toBeDefined();
    expect(updateCall!.body).toContain('- [x] #1');
    expect(updateCall!.body).toContain('- [ ] #99');
  });

  it('per-plan failure does not abort scanning subsequent plans', async () => {
    const body2 = '- [ ] #3\n';
    // Plan 1: parent fetch throws a non-404 error.
    gh.setIssue(PARENT, new Error('GitHub 500'), '');
    // Plan 2: works fine, child already closed.
    gh.setIssue(20, 'open', body2);
    gh.setIssue(3, 'closed');

    store.upsertPlan(REPO, PARENT, [1]);
    store.upsertPlan(REPO, 20, [3]);

    const result = await scanPlansForCompletion(gh as never, store, silentLog);

    expect(result.scannedPlans).toBe(2);
    // Plan 2 child closed → body updated.
    expect(result.updatedBodies).toBe(1);
  });

  it('recordPlanCheck is called for each processed plan', async () => {
    gh.setIssue(PARENT, 'open', '- [ ] #1\n');
    gh.setIssue(1, 'open');
    store.upsertPlan(REPO, PARENT, [1]);

    // last_checked_at starts null.
    expect(store.listOpenPlans()[0]!.last_checked_at).toBeNull();

    await scanPlansForCompletion(gh as never, store, silentLog);

    expect(store.listOpenPlans()[0]!.last_checked_at).not.toBeNull();
  });

  it('body with [X] uppercase checkbox is recognized and normalized to [x]', async () => {
    const body = '- [X] #1\n';
    gh.setIssue(PARENT, 'open', body);
    gh.setIssue(1, 'open'); // child is now open → should flip to [ ]
    store.upsertPlan(REPO, PARENT, [1]);

    await scanPlansForCompletion(gh as never, store, silentLog);

    const updateCall = gh.updateCalls.find((c) => c.body !== undefined);
    expect(updateCall).toBeDefined();
    expect(updateCall!.body).toBe('- [ ] #1\n');
  });
});
