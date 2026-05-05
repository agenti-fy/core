import { describe, it, expect, beforeEach } from 'vitest';
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

    await pollJobCompletions({ store, agentClient: client, logger: silentLog });

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

    await pollJobCompletions({ store, agentClient: client, logger: silentLog });

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

    await pollJobCompletions({ store, agentClient: client, logger: silentLog });

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

    await pollJobCompletions({ store, agentClient: client, logger: silentLog });

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

    await pollJobCompletions({ store, agentClient: client, logger: silentLog });

    expect(store.getSession(a.agent_id, 'acme/api')).toBeNull();
    store.close();
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

    await pollJobCompletions({ store, agentClient: client, logger: silentLog });

    expect(store.listRecentJobs()[0]?.job_id).toBe('j_2');
    store.close();
  });
});
