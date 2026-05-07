import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';
import type { AgentStatusResponse, JobResult, Method } from '@agentify/shared';
import { CoordinatorStore } from '../store.js';
import type { GetJobResult } from '../agent-client.js';
import { pollJobCompletions } from './job-poller.js';

const silentLog: Logger = pino({ level: 'silent' });

/** Default config for tests — generous cap so existing happy-path jobs are unaffected. */
const DEFAULT_CONFIG = { maxResultJsonBytes: 256 * 1024 };

function freshStore(): CoordinatorStore {
  const dir = mkdtempSync(join(tmpdir(), 'agentify-job-poller-'));
  return new CoordinatorStore(join(dir, 'test.db'));
}

type FakeJobValue = JobResult | 'in_flight' | 'missing' | Error;

interface FakeStatus {
  status?: AgentStatusResponse | Error;
  jobs?: Map<string, FakeJobValue>;
}

class FakeAgentClient {
  cfg = new Map<string, FakeStatus>();
  setStatus(url: string, s: AgentStatusResponse | Error): void {
    const cur = this.cfg.get(url) ?? {};
    cur.status = s;
    this.cfg.set(url, cur);
  }
  setJob(url: string, jobId: string, r: FakeJobValue): void {
    const cur = this.cfg.get(url) ?? { jobs: new Map() };
    if (!cur.jobs) cur.jobs = new Map();
    cur.jobs.set(jobId, r);
    this.cfg.set(url, cur);
  }
  async getStatus(url: string): Promise<AgentStatusResponse> {
    const s = this.cfg.get(url)?.status;
    if (!s) throw new Error(`no fake status for ${url}`);
    if (s instanceof Error) throw s;
    return s;
  }
  async getJob(url: string, jobId: string): Promise<GetJobResult> {
    const r = this.cfg.get(url)?.jobs?.get(jobId);
    if (r === undefined || r === 'missing') return { kind: 'missing' };
    if (r === 'in_flight') return { kind: 'in_flight' };
    if (r instanceof Error) throw r;
    return { kind: 'done', result: r };
  }
  async dispatch(): Promise<never> { throw new Error('not used'); }
  async reset(): Promise<never> { throw new Error('not used'); }
}

function regAgent(store: CoordinatorStore, name = 'tinkerer-1', methods: Method[] = ['plan']) {
  return store.registerAgent({
    name,
    type: 'tinkerer',
    version: '0.1.0',
    url: `http://${name}:8080`,
    supported_methods: methods,
  });
}

function jobResult(over: Partial<JobResult> = {}): JobResult {
  return {
    job_id: 'j_1',
    method: 'plan',
    repo: 'acme/api',
    target_id: 7,
    outcome: 'success',
    session_id: 'sess-1',
    duration_ms: 1234,
    artifacts: {},
    ...over,
  };
}

function insertActiveJob(
  store: CoordinatorStore,
  agentId: string,
  over: { job_id?: string; method?: Method; target_id?: number; status?: 'dispatched' | 'running' } = {},
): void {
  store.insertJob({
    job_id: over.job_id ?? 'j_1',
    agent_id: agentId,
    method: over.method ?? 'plan',
    repo: 'acme/api',
    target_id: over.target_id ?? 7,
    persona_name: 'tinkerer',
    status: over.status ?? 'running',
    dispatched_at: Date.now(),
  });
}

describe('pollJobCompletions', () => {
  let store: CoordinatorStore;
  let client: FakeAgentClient;

  beforeEach(() => {
    store = freshStore();
    client = new FakeAgentClient();
  });

  it('records BUSY→IDLE transition: marks job complete and persists session', async () => {
    const a = regAgent(store);
    store.recordHeartbeat(a.agent_id, 'BUSY');
    insertActiveJob(store, a.agent_id);
    client.setStatus(a.url, {
      status: 'IDLE',
      agent_id: a.agent_id,
      current_job: null,
      last_failure: null,
    });
    client.setJob(a.url, 'j_1', jobResult());

    await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

    const updated = store.listRecentJobs();
    expect(updated).toHaveLength(1);
    expect(updated[0]?.status).toBe('complete');
    expect(updated[0]?.outcome).toBe('success');
    expect(store.getSession(a.agent_id, 'acme/api')).toBe('sess-1');
    expect(store.getAgent(a.agent_id)?.last_known_status).toBe('IDLE');
    store.close();
  });

  it('promotes dispatched→running when agent reports the job as current', async () => {
    const a = regAgent(store);
    insertActiveJob(store, a.agent_id, { status: 'dispatched' });
    client.setStatus(a.url, {
      status: 'BUSY',
      agent_id: a.agent_id,
      current_job: { id: 'j_1', method: 'plan', repo: 'acme/api', target_id: 7, started_at: Date.now() },
      last_failure: null,
    });

    await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

    expect(store.listOpenJobs()[0]?.status).toBe('running');
    store.close();
  });

  it('does NOT orphan when agent reports the job is still in flight (race window)', async () => {
    // Race: dispatcher inserted a new job AFTER our /status snapshot was taken,
    // so status.current_job is null but the agent has the job in state.jobs
    // with completed_at=null. Pre-fix this would orphan the healthy job.
    const a = regAgent(store);
    insertActiveJob(store, a.agent_id, { job_id: 'j_inflight' });
    client.setStatus(a.url, {
      status: 'IDLE', // stale snapshot — agent hadn't accepted yet when /status served
      agent_id: a.agent_id,
      current_job: null,
      last_failure: null,
    });
    client.setJob(a.url, 'j_inflight', 'in_flight');

    await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

    // Job stays running, not marked orphaned. Next poll tick will resolve it.
    const open = store.listOpenJobs();
    expect(open).toHaveLength(1);
    expect(open[0]?.status).toBe('running');
    expect(store.listRecentJobs()).toHaveLength(0);
    store.close();
  });

  it('marks orphaned when agent has no record of the job', async () => {
    const a = regAgent(store);
    insertActiveJob(store, a.agent_id, { job_id: 'j_dead' });
    client.setStatus(a.url, {
      status: 'IDLE',
      agent_id: a.agent_id,
      current_job: null,
      last_failure: null,
    });
    // No job entry at all → fake returns missing.

    await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

    const recent = store.listRecentJobs();
    expect(recent[0]?.status).toBe('failed');
    expect(recent[0]?.outcome).toBe('orphaned');
    store.close();
  });

  it('skips persisting session_id on sdk_failure', async () => {
    const a = regAgent(store);
    insertActiveJob(store, a.agent_id);
    client.setStatus(a.url, {
      status: 'FAILURE',
      agent_id: a.agent_id,
      current_job: null,
      last_failure: { code: 'sdk_failure', message: 'boom', ts: Date.now() },
    });
    client.setJob(a.url, 'j_1', jobResult({ outcome: 'sdk_failure', session_id: 'sess-x' }));

    await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

    expect(store.getSession(a.agent_id, 'acme/api')).toBeNull();
    store.close();
  });

  describe('plan upsert recording', () => {
    function planResult(over: Partial<JobResult> = {}): JobResult {
      return jobResult({
        method: 'plan',
        outcome: 'success',
        artifacts: { plan: { child_issues: [1, 2, 3] } },
        ...over,
      });
    }

    function setupIdleAgent(s: CoordinatorStore, c: FakeAgentClient, jobId = 'j_1') {
      const a = regAgent(s);
      s.recordHeartbeat(a.agent_id, 'BUSY');
      insertActiveJob(s, a.agent_id, { job_id: jobId });
      c.setStatus(a.url, {
        status: 'IDLE',
        agent_id: a.agent_id,
        current_job: null,
        last_failure: null,
      });
      return a;
    }

    it('calls upsertPlan when plan job succeeds with child_issues', async () => {
      const a = setupIdleAgent(store, client);
      client.setJob(a.url, 'j_1', planResult());

      await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

      const plans = store.listOpenPlans();
      expect(plans).toHaveLength(1);
      expect(plans[0]?.repo).toBe('acme/api');
      expect(plans[0]?.parent_id).toBe(7);
      expect(plans[0]?.child_ids).toEqual([1, 2, 3]);
      store.close();
    });

    it('does NOT call upsertPlan when child_issues is empty', async () => {
      const a = setupIdleAgent(store, client);
      client.setJob(a.url, 'j_1', planResult({ artifacts: { plan: { child_issues: [] } } }));

      await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

      expect(store.listOpenPlans()).toHaveLength(0);
      store.close();
    });

    it('does NOT call upsertPlan for non-plan method', async () => {
      const a = regAgent(store, 'tinkerer-1', ['implement']);
      store.recordHeartbeat(a.agent_id, 'BUSY');
      insertActiveJob(store, a.agent_id, { method: 'implement' });
      client.setStatus(a.url, {
        status: 'IDLE',
        agent_id: a.agent_id,
        current_job: null,
        last_failure: null,
      });
      client.setJob(a.url, 'j_1', jobResult({ method: 'implement', artifacts: {} }));

      await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

      expect(store.listOpenPlans()).toHaveLength(0);
      store.close();
    });

    it('does NOT call upsertPlan when plan outcome is task_error', async () => {
      const a = setupIdleAgent(store, client);
      client.setJob(
        a.url,
        'j_1',
        planResult({ outcome: 'task_error', artifacts: { plan: { child_issues: [1, 2] } } }),
      );

      await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

      expect(store.listOpenPlans()).toHaveLength(0);
      store.close();
    });
  });

  it('survives unreachable agent (status throws) without poisoning other agents', async () => {
    const a1 = regAgent(store, 'a1');
    const a2 = regAgent(store, 'a2');
    insertActiveJob(store, a2.agent_id, { job_id: 'j_2', target_id: 9 });
    client.setStatus(a1.url, new Error('ECONNREFUSED'));
    client.setStatus(a2.url, {
      status: 'IDLE',
      agent_id: a2.agent_id,
      current_job: null,
      last_failure: null,
    });
    client.setJob(a2.url, 'j_2', jobResult({ job_id: 'j_2', target_id: 9 }));

    await pollJobCompletions({ store, agentClient: client, logger: silentLog, config: DEFAULT_CONFIG });

    expect(store.listRecentJobs()[0]?.job_id).toBe('j_2');
    store.close();
  });

  describe('result_json payload-size cap', () => {
    /** Helper: register agent, insert active job, configure it as IDLE with the given result. */
    function setupCompletedAgent(
      s: CoordinatorStore,
      c: FakeAgentClient,
      result: JobResult,
      jobId = 'j_1',
    ): { agent_id: string; url: string } {
      const a = regAgent(s);
      s.recordHeartbeat(a.agent_id, 'BUSY');
      insertActiveJob(s, a.agent_id, { job_id: jobId });
      c.setStatus(a.url, {
        status: 'IDLE',
        agent_id: a.agent_id,
        current_job: null,
        last_failure: null,
      });
      c.setJob(a.url, jobId, result);
      return a;
    }

    it('when result_json exceeds cap, persists task_error with artifacts: {}', async () => {
      const s = freshStore();
      const c = new FakeAgentClient();
      // A tiny cap that any non-trivial JobResult will blow past.
      const tinyCapConfig = { maxResultJsonBytes: 10 };
      // Inflate by stuffing a large final_text (easy to produce in a test; in
      // production, final_text is already truncated at the agent boundary).
      const bigResult = jobResult({ final_text: 'x'.repeat(200) });
      setupCompletedAgent(s, c, bigResult);

      await pollJobCompletions({ store: s, agentClient: c, logger: silentLog, config: tinyCapConfig });

      const jobs = s.listRecentJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.outcome).toBe('task_error');
      const persisted: unknown = JSON.parse(jobs[0]?.result_json ?? '{}');
      expect((persisted as { artifacts: unknown }).artifacts).toEqual({});
      expect(
        ((persisted as { error: { message: string } }).error?.message),
      ).toContain('MAX_RESULT_JSON_BYTES');
      s.close();
    });

    it('logs a warning when result_json exceeds the cap', async () => {
      const s = freshStore();
      const c = new FakeAgentClient();
      const warnSpy = vi.fn();
      // Override only warn so we can assert on it; other methods stay silent.
      const spyLog = { ...silentLog, warn: warnSpy } as unknown as Logger;
      const tinyCapConfig = { maxResultJsonBytes: 10 };
      const bigResult = jobResult({ final_text: 'x'.repeat(200) });
      setupCompletedAgent(s, c, bigResult);

      await pollJobCompletions({ store: s, agentClient: c, logger: spyLog, config: tinyCapConfig });

      // pino logs with (obj, msg) signature; the message is the second argument.
      const capWarnings = warnSpy.mock.calls.filter(
        (args: unknown[]) =>
          typeof args[1] === 'string' && args[1].includes('MAX_RESULT_JSON_BYTES'),
      );
      expect(capWarnings.length).toBeGreaterThan(0);
      // The structured object (first arg) should carry the diagnostic fields.
      const obj = capWarnings[0]?.[0] as Record<string, unknown>;
      expect(typeof obj['serialized_bytes']).toBe('number');
      expect(typeof obj['cap']).toBe('number');
      s.close();
    });

    it('does not replace artifacts when result_json is within the cap', async () => {
      const s = freshStore();
      const c = new FakeAgentClient();
      // Use a cap large enough for any realistic test result.
      const generousConfig = { maxResultJsonBytes: 1024 * 1024 };
      const normalResult = jobResult({ artifacts: { plan: { child_issues: [1, 2] } } });
      setupCompletedAgent(s, c, normalResult);

      await pollJobCompletions({ store: s, agentClient: c, logger: silentLog, config: generousConfig });

      const jobs = s.listRecentJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.outcome).toBe('success');
      const persisted: unknown = JSON.parse(jobs[0]?.result_json ?? '{}');
      expect(
        (persisted as { artifacts: { plan?: { child_issues?: number[] } } }).artifacts?.plan
          ?.child_issues,
      ).toEqual([1, 2]);
      s.close();
    });
  });
});
