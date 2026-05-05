import { describe, it, expect } from 'vitest';
import type { JobResult } from '@agentify/shared';
import { AgentState } from './state.js';

function jobResult(over: Partial<JobResult> = {}): JobResult {
  return {
    job_id: 'j_1',
    method: 'plan',
    repo: 'acme/api',
    target_id: 7,
    outcome: 'success',
    session_id: null,
    duration_ms: 100,
    artifacts: {},
    ...over,
  };
}

describe('AgentState.startJob', () => {
  it('refuses to start if not IDLE', () => {
    const s = new AgentState();
    expect(
      s.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: 0 }),
    ).toBe(true);
    // already BUSY now
    expect(
      s.startJob({ id: 'j_2', method: 'plan', repo: 'acme/api', target_id: 8, started_at: 0 }),
    ).toBe(false);
  });
});

describe('AgentState.completeJob', () => {
  it('happy path: records result and flips status to IDLE', () => {
    const s = new AgentState();
    s.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: 0 });
    s.completeJob(jobResult());
    expect(s.getStatus()).toBe('IDLE');
    expect(s.getCurrentJob()).toBeNull();
    expect(s.getJob('j_1')?.result?.outcome).toBe('success');
  });

  it('flips to FAILURE on sdk_failure outcome', () => {
    const s = new AgentState();
    s.startJob({ id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: 0 });
    s.completeJob(jobResult({ outcome: 'sdk_failure', error: { message: 'boom' } }));
    expect(s.getStatus()).toBe('FAILURE');
    expect(s.getLastFailure()?.code).toBe('sdk_failure');
  });

  it('does NOT clobber currentJob on a stale completion for a different job_id', () => {
    // Defensive: a stale completeJob(oldJob) call while a newer job is running
    // must not flip the agent to IDLE — that would let the next dispatch
    // barge into a still-busy agent.
    const s = new AgentState();
    s.startJob({ id: 'active', method: 'plan', repo: 'acme/api', target_id: 7, started_at: 0 });
    s.completeJob(jobResult({ job_id: 'unrelated' }));
    expect(s.getStatus()).toBe('BUSY');
    expect(s.getCurrentJob()?.id).toBe('active');
  });

  it('records result for a stale completion even though status is unchanged', () => {
    // We DO record the result on the historical job entry — the late
    // completion is still useful data; we just don't let it touch live state.
    const s = new AgentState();
    s.startJob({ id: 'old', method: 'plan', repo: 'acme/api', target_id: 7, started_at: 0 });
    s.completeJob(jobResult({ job_id: 'old' })); // → IDLE
    s.startJob({ id: 'new', method: 'plan', repo: 'acme/api', target_id: 8, started_at: 0 });
    // Late duplicate completion for 'old':
    s.completeJob(jobResult({ job_id: 'old', outcome: 'task_error' }));
    expect(s.getStatus()).toBe('BUSY');
    expect(s.getCurrentJob()?.id).toBe('new');
    expect(s.getJob('old')?.result?.outcome).toBe('task_error');
  });
});
