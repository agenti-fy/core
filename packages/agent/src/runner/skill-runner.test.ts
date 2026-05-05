import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import type { Logger } from 'pino';
import {
  inProgressLabel,
  NEEDS_HUMAN_LABEL,
  routingLabel,
  type JobOutcome,
  type Method,
  type ParsedSoul,
} from '@agentify/shared';
import { SoulRef } from '../soul/ref.js';
import { AgentState } from '../state.js';
import type { Config } from '../config.js';
import type { ClaudeAdapter, SkillRunOptions, SkillRunOutput } from '../claude/adapter.js';
import type { CoordinatorClient } from '../coordinator-client.js';
import type { GitHubAdapter } from '../github/client.js';
import type { WorktreeManager } from '../git/worktree.js';
import { SkillRunner } from './skill-runner.js';

const silentLog: Logger = pino({ level: 'silent' });

function makeSoul(): ParsedSoul {
  return {
    frontmatter: {
      name: 'tinkerer',
      type: 'tinkerer',
      version: '0.1.0',
    },
    personaBody: 'You are a tinkerer.',
    skillOverrides: {},
  };
}

class FakeGitHub implements GitHubAdapter {
  enabled = true;
  labels = ['needs:plan'];
  comments: string[] = [];
  /** Final body after each `appendToIssueBody` call. Modeling read-modify-write
   *  faithfully so a regression that goes back to body-replace would surface. */
  bodies: string[] = [];
  body = 'original operator-authored issue body';
  failComment = false;
  failBody = false;
  /** Counter for replaceLabels calls. When > 0, the NEXT replaceLabels throws. */
  failNextReplaceLabels = 0;
  /** Stubbed PR state for the merge-verification path. Null = no-github mode. */
  prState: { state: 'open' | 'closed'; merged: boolean; mergeCommitSha: string | null } | null = {
    state: 'closed',
    merged: true,
    mergeCommitSha: 'deadbeef',
  };
  /** When true, getPullRequest throws (simulating a GitHub API blip). */
  failGetPullRequest = false;
  getPrCalls: Array<{ repo: string; number: number }> = [];
  async listLabels(): Promise<string[]> { return [...this.labels]; }
  async addLabels(_repo: string, _n: number, l: readonly string[]): Promise<void> {
    for (const x of l) if (!this.labels.includes(x)) this.labels.push(x);
  }
  async removeLabels(_repo: string, _n: number, l: readonly string[]): Promise<void> {
    this.labels = this.labels.filter((x) => !l.includes(x));
  }
  async replaceLabels(_repo: string, _n: number, l: readonly string[]): Promise<void> {
    if (this.failNextReplaceLabels > 0) {
      this.failNextReplaceLabels--;
      throw new Error('replaceLabels failed (simulated GitHub blip)');
    }
    this.labels = [...l];
  }
  async appendToIssueBody(_repo: string, _n: number, suffix: string): Promise<void> {
    if (this.failBody) throw new Error('body update fail');
    this.body = this.body.length > 0 ? `${this.body}\n\n${suffix}` : suffix;
    this.bodies.push(this.body);
  }
  async postIssueComment(_repo: string, _n: number, body: string): Promise<void> {
    if (this.failComment) throw new Error('comment fail');
    this.comments.push(body);
  }
  async getPullRequest(repo: string, number: number) {
    this.getPrCalls.push({ repo, number });
    if (this.failGetPullRequest) throw new Error('GitHub API blip on pulls.get');
    return this.prState;
  }
}

class FakeWorktree {
  prepareImpl: () => Promise<{ path: string; branch: string | null }> = async () => ({
    path: '/tmp/wt',
    branch: 'feat/foo',
  });
  cleanupCalls: number = 0;
  /** Token the runner injects as GH_TOKEN before each adapter.run() call. */
  installationToken: string | null = 'ghi-fake-installation-token';
  async getInstallationToken(): Promise<string | null> {
    return this.installationToken;
  }
  async prepare(): Promise<{ path: string; branch: string | null }> {
    return this.prepareImpl();
  }
  async cleanup(): Promise<void> {
    this.cleanupCalls++;
  }
}

class FakeAdapter implements ClaudeAdapter {
  next: SkillRunOutput | Error = {
    outcome: 'success',
    sessionId: 'sess-1',
    artifacts: {},
  };
  lastOpts: SkillRunOptions | null = null;
  async run(opts: SkillRunOptions): Promise<SkillRunOutput> {
    this.lastOpts = opts;
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

class FakeCoordinator {
  sessions = new Map<string, string>();
  putCalls: Array<{ agent_id: string; repo: string; session_id: string }> = [];
  failPut = false;
  async putSession(agent_id: string, repo: string, session_id: string): Promise<void> {
    if (this.failPut) throw new Error('put fail');
    this.putCalls.push({ agent_id, repo, session_id });
    this.sessions.set(`${agent_id}|${repo}`, session_id);
  }
  async register(): Promise<never> { throw new Error('not used'); }
  async heartbeat(): Promise<never> { throw new Error('not used'); }
}

interface Deps {
  runner: SkillRunner;
  github: FakeGitHub;
  worktree: FakeWorktree;
  adapter: FakeAdapter;
  coord: FakeCoordinator;
  state: AgentState;
}

function build(): Deps {
  const state = new AgentState({ capacity: 100 });
  state.setAgentId('agent-1');
  const github = new FakeGitHub();
  const worktree = new FakeWorktree();
  const adapter = new FakeAdapter();
  const coord = new FakeCoordinator();
  const runner = new SkillRunner({
    config: {} as Config,
    soulRef: new SoulRef(makeSoul()),
    coordinator: coord as unknown as CoordinatorClient,
    adapter,
    github,
    worktreeManager: worktree as unknown as WorktreeManager,
    state,
    logger: silentLog,
  });
  return { runner, github, worktree, adapter, coord, state };
}

async function runOnce(
  runner: SkillRunner,
  method: Method = 'plan',
  session_id: string | null = null,
): Promise<void> {
  // Use the private `run` via enqueue-style flow but without setImmediate:
  // call .enqueue and then drain the microtask + setImmediate queue.
  runner.enqueue({
    job_id: 'j_1',
    method,
    repo: 'acme/api',
    target_id: 7,
    persona_name: 'tinkerer',
    session_id,
  });
  await new Promise<void>((r) => setImmediate(r));
  // setImmediate may have scheduled another tick — yield once more.
  await new Promise<void>((r) => setImmediate(r));
}

describe('SkillRunner.run', () => {
  let d: Deps;
  beforeEach(() => {
    d = build();
  });

  it('happy path: success outcome, in-progress flipped + cleared, session persisted', async () => {
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });
    await runOnce(d.runner);

    expect(d.adapter.lastOpts).not.toBeNull();
    expect(d.github.labels).not.toContain(routingLabel('tinkerer', 'plan'));
    expect(d.github.labels).not.toContain(inProgressLabel('tinkerer', 'plan'));
    expect(d.coord.putCalls).toEqual([
      { agent_id: 'agent-1', repo: 'acme/api', session_id: 'sess-1' },
    ]);
    expect(d.worktree.cleanupCalls).toBe(1);
    expect(d.state.getStatus()).toBe('IDLE');
    const job = d.state.getJob('j_1');
    expect(job?.result?.outcome).toBe('success');
  });

  it('task_error: posts failure comment and applies needs-human label', async () => {
    d.adapter.next = {
      outcome: 'task_error',
      sessionId: 'sess-2',
      artifacts: {},
      error: { message: 'something went wrong' },
    };
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });

    await runOnce(d.runner);

    expect(d.github.comments).toHaveLength(1);
    expect(d.github.comments[0]).toContain('something went wrong');
    expect(d.github.labels).toContain(NEEDS_HUMAN_LABEL);
    expect(d.github.labels).not.toContain(inProgressLabel('tinkerer', 'plan'));
    expect(d.state.getJob('j_1')?.result?.outcome).toBe('task_error');
  });

  it('task_error with comment failure: falls back to APPENDING to issue body (preserves original)', async () => {
    d.github.failComment = true;
    d.adapter.next = {
      outcome: 'task_error',
      sessionId: null,
      artifacts: {},
      error: { message: 'kaboom' },
    };
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });

    await runOnce(d.runner);

    expect(d.github.comments).toHaveLength(0);
    expect(d.github.bodies).toHaveLength(1);
    expect(d.github.bodies[0]).toContain('kaboom');
    expect(d.github.bodies[0]).toContain('failure marker');
    // Critical: the original operator-authored body must NOT have been
    // overwritten. A regression that goes back to body-replace would lose this.
    expect(d.github.bodies[0]).toContain('original operator-authored issue body');
    expect(d.github.labels).toContain(NEEDS_HUMAN_LABEL);
  });

  it('worktree prepare failure: marks needs-human (not revert) and records config_failure', async () => {
    d.worktree.prepareImpl = async () => {
      throw new Error('disk full');
    };
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });

    await runOnce(d.runner);

    // Don't revert to task:<method> — would re-route to fail again. needs-human stops the loop.
    expect(d.github.labels).not.toContain(routingLabel('tinkerer', 'plan'));
    expect(d.github.labels).not.toContain(inProgressLabel('tinkerer', 'plan'));
    expect(d.github.labels).toContain(NEEDS_HUMAN_LABEL);
    expect(d.github.comments).toHaveLength(1);
    expect(d.github.comments[0]).toContain('disk full');
    expect(d.state.getStatus()).toBe('FAILURE');
    const job = d.state.getJob('j_1');
    expect(job?.result?.outcome).toBe('config_failure');
    expect(d.worktree.cleanupCalls).toBe(0);
  });

  it('adapter throws: cleans worktree, marks needs-human, records sdk_failure', async () => {
    d.adapter.next = new Error('SDK exploded');
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });

    await runOnce(d.runner);

    expect(d.worktree.cleanupCalls).toBe(1);
    expect(d.github.labels).not.toContain(routingLabel('tinkerer', 'plan'));
    expect(d.github.labels).toContain(NEEDS_HUMAN_LABEL);
    expect(d.github.comments[0]).toContain('SDK exploded');
    expect(d.state.getStatus()).toBe('FAILURE');
    expect(d.state.getJob('j_1')?.result?.outcome).toBe('sdk_failure');
  });

  it('adapter returns sdk_failure: also marks needs-human (no infinite loop)', async () => {
    d.adapter.next = {
      outcome: 'sdk_failure',
      sessionId: null,
      artifacts: {},
      error: { message: 'Anthropic 500' },
    };
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });

    await runOnce(d.runner);

    expect(d.github.labels).not.toContain(routingLabel('tinkerer', 'plan'));
    expect(d.github.labels).not.toContain(inProgressLabel('tinkerer', 'plan'));
    expect(d.github.labels).toContain(NEEDS_HUMAN_LABEL);
    expect(d.github.comments[0]).toContain('Anthropic 500');
    expect(d.state.getStatus()).toBe('FAILURE');
    expect(d.state.getJob('j_1')?.result?.outcome).toBe('sdk_failure');
  });

  it('adapter returns auth_failure: marks needs-human and FAILURE', async () => {
    d.adapter.next = {
      outcome: 'auth_failure',
      sessionId: null,
      artifacts: {},
      error: { message: '401 unauthorized' },
    };
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });

    await runOnce(d.runner);

    expect(d.github.labels).toContain(NEEDS_HUMAN_LABEL);
    expect(d.github.comments[0]).toContain('401 unauthorized');
    expect(d.state.getStatus()).toBe('FAILURE');
  });

  it('flipToInProgress: replaces task: label atomically (not double-add)', async () => {
    d.github.labels = [routingLabel('tinkerer', 'plan'), 'agent:tinkerer'];
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });
    await runOnce(d.runner);

    // After success, in-progress is removed; verify there's no leftover task: label either.
    expect(d.github.labels).not.toContain(routingLabel('tinkerer', 'plan'));
    expect(d.github.labels).not.toContain(inProgressLabel('tinkerer', 'plan'));
    expect(d.github.labels).toContain('agent:tinkerer');
  });

  it('success path clears task: label even when flipToInProgress failed', async () => {
    // Simulate a GitHub blip during the flip — replaceLabels throws once.
    // Without the success-path defensive cleanup, the original task: label
    // would still be on the issue and the work-poller would re-route the
    // same target on its next tick (duplicate work, doubled child issues).
    d.github.labels = [routingLabel('tinkerer', 'plan'), 'agent:tinkerer'];
    d.github.failNextReplaceLabels = 1; // fails the flip
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });

    await runOnce(d.runner);

    // Flip failed, so in-progress was never added. Crucially, the success
    // path's removeLabels MUST clear task:plan defensively, even though
    // the in-progress marker isn't present.
    expect(d.github.labels).not.toContain(routingLabel('tinkerer', 'plan'));
    expect(d.github.labels).not.toContain(inProgressLabel('tinkerer', 'plan'));
    expect(d.github.labels).toContain('agent:tinkerer');
  });

  it('does not persist session_id when outcome is sdk_failure', async () => {
    d.adapter.next = {
      outcome: 'sdk_failure' as JobOutcome,
      sessionId: 'should-not-persist',
      artifacts: {},
    };
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });

    await runOnce(d.runner);

    expect(d.coord.putCalls).toHaveLength(0);
  });

  it('injects GH_TOKEN into process.env for the adapter run and restores it after', async () => {
    // Capture the env that the adapter sees mid-run; restore must happen after.
    const seen: { mid: string | undefined; restored: string | undefined } = {
      mid: undefined,
      restored: undefined,
    };
    const original = process.env['GH_TOKEN'];
    process.env['GH_TOKEN'] = 'pre-existing-token';
    d.adapter.run = async () => {
      seen.mid = process.env['GH_TOKEN'];
      return { outcome: 'success', sessionId: 'sess-1', artifacts: {} };
    };
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });
    await runOnce(d.runner);
    seen.restored = process.env['GH_TOKEN'];
    process.env['GH_TOKEN'] = original ?? '';
    if (original === undefined) delete process.env['GH_TOKEN'];

    expect(seen.mid).toBe('ghi-fake-installation-token');
    expect(seen.restored).toBe('pre-existing-token');
  });

  it('restores GH_TOKEN even when the adapter throws', async () => {
    const original = process.env['GH_TOKEN'];
    delete process.env['GH_TOKEN'];
    d.adapter.next = new Error('boom');
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });
    await runOnce(d.runner);

    expect(process.env['GH_TOKEN']).toBeUndefined();
    if (original !== undefined) process.env['GH_TOKEN'] = original;
  });

  it('catches unhandled errors via enqueue and still marks state', async () => {
    // Force a throw before any state work — make adapter throw.
    d.adapter.next = new Error('explode');
    d.state.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() });
    const errSpy = vi.spyOn(silentLog, 'error');
    await runOnce(d.runner);

    expect(d.state.getJob('j_1')?.result?.outcome).toBe('sdk_failure');
    errSpy.mockRestore();
  });

  describe('merge verification', () => {
    // Real incident: agenti-fy/example-calc#52 — conductor pushed the resolved
    // tree directly to main, then `gh pr close --delete-branch`-d the PR, and
    // returned `outcome: success` with `final_text` claiming `merged: true`.
    // Without verification the runner cleared labels and the operator saw a
    // green job. These tests pin the runner-side defense.

    it('merge success with PR actually merged: passes verification, clears labels', async () => {
      d.github.prState = { state: 'closed', merged: true, mergeCommitSha: 'abc123' };
      d.adapter.next = {
        outcome: 'success',
        sessionId: 'sess-merge',
        artifacts: {},
        finalText: 'merged it',
      };
      d.state.startJob({ id: 'j_1', method: 'merge', repo: 'acme/api', target_id: 7, started_at: Date.now() });

      await runOnce(d.runner, 'merge');

      expect(d.github.getPrCalls).toEqual([{ repo: 'acme/api', number: 7 }]);
      expect(d.state.getJob('j_1')?.result?.outcome).toBe('success');
      expect(d.github.labels).not.toContain(NEEDS_HUMAN_LABEL);
      expect(d.github.comments).toHaveLength(0);
    });

    it('merge success but PR closed-not-merged: downgrades to task_error and applies needs-human', async () => {
      d.github.prState = { state: 'closed', merged: false, mergeCommitSha: null };
      d.adapter.next = {
        outcome: 'success',
        sessionId: 'sess-merge',
        artifacts: {},
        finalText: '✅ Merge successful. PR #7 has been merged to main.',
      };
      d.state.startJob({ id: 'j_1', method: 'merge', repo: 'acme/api', target_id: 7, started_at: Date.now() });

      await runOnce(d.runner, 'merge');

      const job = d.state.getJob('j_1');
      expect(job?.result?.outcome).toBe('task_error');
      expect(job?.result?.error?.message).toContain('GitHub disagrees');
      expect(job?.result?.error?.message).toContain('merged=false');
      // The agent's lying claim must surface in the failure comment so the
      // operator can see what was hallucinated, not just what was real.
      expect(d.github.comments).toHaveLength(1);
      expect(d.github.comments[0]).toContain('Merge skill reported success');
      expect(d.github.comments[0]).toContain('✅ Merge successful');
      expect(d.github.labels).toContain(NEEDS_HUMAN_LABEL);
    });

    it('merge success but PR still open: downgrades to task_error', async () => {
      d.github.prState = { state: 'open', merged: false, mergeCommitSha: null };
      d.adapter.next = {
        outcome: 'success',
        sessionId: 'sess-merge',
        artifacts: {},
        finalText: 'all done',
      };
      d.state.startJob({ id: 'j_1', method: 'merge', repo: 'acme/api', target_id: 7, started_at: Date.now() });

      await runOnce(d.runner, 'merge');

      expect(d.state.getJob('j_1')?.result?.outcome).toBe('task_error');
      expect(d.github.comments[0]).toContain('state=open');
      expect(d.github.labels).toContain(NEEDS_HUMAN_LABEL);
    });

    it('verification skipped for non-merge methods', async () => {
      d.github.prState = { state: 'open', merged: false, mergeCommitSha: null };
      d.adapter.next = { outcome: 'success', sessionId: 'sess-1', artifacts: {} };
      d.state.startJob({ id: 'j_1', method: 'review', repo: 'acme/api', target_id: 7, started_at: Date.now() });

      await runOnce(d.runner, 'review');

      // No PR fetch for non-merge methods — verification is scoped narrowly.
      expect(d.github.getPrCalls).toHaveLength(0);
      expect(d.state.getJob('j_1')?.result?.outcome).toBe('success');
    });

    it('verification skipped when outcome was already not success', async () => {
      d.adapter.next = {
        outcome: 'task_error',
        sessionId: 'sess-1',
        artifacts: {},
        error: { message: 'pre-existing failure' },
      };
      d.state.startJob({ id: 'j_1', method: 'merge', repo: 'acme/api', target_id: 7, started_at: Date.now() });

      await runOnce(d.runner, 'merge');

      // No need to verify a non-success — the model already said it failed.
      expect(d.github.getPrCalls).toHaveLength(0);
      expect(d.state.getJob('j_1')?.result?.outcome).toBe('task_error');
    });

    it('verification skipped in no-github mode (getPullRequest returns null)', async () => {
      d.github.prState = null; // simulates NullGitHubAdapter
      d.adapter.next = {
        outcome: 'success',
        sessionId: 'sess-merge',
        artifacts: {},
        finalText: 'merged',
      };
      d.state.startJob({ id: 'j_1', method: 'merge', repo: 'acme/api', target_id: 7, started_at: Date.now() });

      await runOnce(d.runner, 'merge');

      // We trust the adapter when there's no real GitHub to check against —
      // tests/CI/dev environments shouldn't be forced to flip to task_error.
      expect(d.state.getJob('j_1')?.result?.outcome).toBe('success');
      expect(d.github.labels).not.toContain(NEEDS_HUMAN_LABEL);
    });

    it('verification API failure is non-fatal: trusts the model', async () => {
      // Failing closed on every API blip would cause spurious needs-human
      // flaps for transient GitHub issues. The next monitor tick catches
      // a genuine bad-state PR anyway.
      d.github.failGetPullRequest = true;
      d.adapter.next = {
        outcome: 'success',
        sessionId: 'sess-merge',
        artifacts: {},
        finalText: 'merged',
      };
      d.state.startJob({ id: 'j_1', method: 'merge', repo: 'acme/api', target_id: 7, started_at: Date.now() });

      await runOnce(d.runner, 'merge');

      expect(d.state.getJob('j_1')?.result?.outcome).toBe('success');
      expect(d.github.labels).not.toContain(NEEDS_HUMAN_LABEL);
    });
  });
});
