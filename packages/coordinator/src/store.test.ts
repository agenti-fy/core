import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { CoordinatorStore } from './store.js';

function freshStore(): CoordinatorStore {
  const dir = mkdtempSync(join(tmpdir(), 'agentify-store-'));
  return new CoordinatorStore(join(dir, 'test.db'));
}

describe('CoordinatorStore.registerAgent', () => {
  it('inserts new agents as IDLE so the dispatcher can route immediately', () => {
    const store = freshStore();
    const a = store.registerAgent({
      name: 'tinkerer-1',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://tinkerer:8080',
      supported_methods: ['plan', 'implement', 'review', 'address_review', 'merge'],
    });
    expect(a.last_known_status).toBe('IDLE');
    store.close();
  });

  it('resets last_known_status to IDLE on re-register', () => {
    const store = freshStore();
    const a = store.registerAgent({
      name: 'tinkerer-1',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://tinkerer:8080',
      supported_methods: ['plan'],
    });
    store.recordHeartbeat(a.agent_id, 'BUSY');
    expect(store.getAgent(a.agent_id)?.last_known_status).toBe('BUSY');

    const b = store.registerAgent({
      name: 'tinkerer-1',
      type: 'tinkerer',
      version: '0.1.1',
      url: 'http://tinkerer:8080',
      supported_methods: ['plan'],
    });
    expect(b.agent_id).toBe(a.agent_id);
    expect(b.last_known_status).toBe('IDLE');
    store.close();
  });
});

describe('CoordinatorStore.pickIdleAgentForPersona', () => {
  it('only returns agents that support the requested method', () => {
    const store = freshStore();
    store.registerAgent({
      name: 'planner-only',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://planner:8080',
      supported_methods: ['plan'],
    });
    expect(store.pickIdleAgentForPersona('tinkerer', 'plan')?.name).toBe('planner-only');
    expect(store.pickIdleAgentForPersona('tinkerer', 'implement')).toBeNull();
    store.close();
  });

  it('matches custom personas by name', () => {
    const store = freshStore();
    store.registerAgent({
      name: 'my-bespoke-bot',
      type: 'custom',
      version: '0.1.0',
      url: 'http://bot:8080',
      supported_methods: ['plan'],
    });
    expect(store.pickIdleAgentForPersona('my-bespoke-bot', 'plan')?.name).toBe('my-bespoke-bot');
    expect(store.pickIdleAgentForPersona('tinkerer', 'plan')).toBeNull();
    store.close();
  });

  it('skips agents not in IDLE state', () => {
    const store = freshStore();
    const a = store.registerAgent({
      name: 'tinkerer-1',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://x:8080',
      supported_methods: ['plan'],
    });
    store.recordHeartbeat(a.agent_id, 'BUSY');
    expect(store.pickIdleAgentForPersona('tinkerer', 'plan')).toBeNull();
    store.close();
  });
});

describe('CoordinatorStore.hasActiveJob and unique active index', () => {
  it('detects in-flight jobs and rejects duplicate inserts', () => {
    const store = freshStore();
    const a = store.registerAgent({
      name: 'tinkerer-1',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://x:8080',
      supported_methods: ['plan'],
    });
    store.insertJob({
      job_id: 'j_1',
      agent_id: a.agent_id,
      persona_name: 'tinkerer',
      method: 'plan',
      repo: 'acme/api',
      target_id: 42,
      status: 'dispatched',
      dispatched_at: Date.now(),
    });
    expect(store.hasActiveJob('acme/api', 'tinkerer', 'plan', 42)).toBe(true);
    expect(() =>
      store.insertJob({
        job_id: 'j_2',
        agent_id: a.agent_id,
      persona_name: 'tinkerer',
        method: 'plan',
        repo: 'acme/api',
        target_id: 42,
        status: 'dispatched',
        dispatched_at: Date.now(),
      }),
    ).toThrow();
    store.close();
  });

  it('lets you re-dispatch after a job is marked complete', () => {
    const store = freshStore();
    const a = store.registerAgent({
      name: 'tinkerer-1',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://x:8080',
      supported_methods: ['plan'],
    });
    store.insertJob({
      job_id: 'j_1',
      agent_id: a.agent_id,
      persona_name: 'tinkerer',
      method: 'plan',
      repo: 'acme/api',
      target_id: 42,
      status: 'dispatched',
      dispatched_at: Date.now(),
    });
    store.updateJobStatus('j_1', 'complete', { outcome: 'success', completed_at: Date.now() });
    expect(store.hasActiveJob('acme/api', 'tinkerer', 'plan', 42)).toBe(false);
    expect(() =>
      store.insertJob({
        job_id: 'j_2',
        agent_id: a.agent_id,
      persona_name: 'tinkerer',
        method: 'plan',
        repo: 'acme/api',
        target_id: 42,
        status: 'dispatched',
        dispatched_at: Date.now(),
      }),
    ).not.toThrow();
    store.close();
  });
});

describe('CoordinatorStore.gcJobs', () => {
  let store: CoordinatorStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('deletes old failed_to_dispatch and complete rows but keeps recent and active ones', () => {
    const a = store.registerAgent({
      name: 'x',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://x:8080',
      supported_methods: ['plan'],
    });
    const longAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;

    store.insertJob({
      job_id: 'old-failed-dispatch',
      agent_id: a.agent_id,
      persona_name: 'tinkerer',
      method: 'plan',
      repo: 'acme/api',
      target_id: 1,
      status: 'dispatched',
      dispatched_at: longAgo,
    });
    store.updateJobStatus('old-failed-dispatch', 'failed_to_dispatch');

    store.insertJob({
      job_id: 'recent-running',
      agent_id: a.agent_id,
      persona_name: 'tinkerer',
      method: 'plan',
      repo: 'acme/api',
      target_id: 2,
      status: 'dispatched',
      dispatched_at: Date.now(),
    });
    store.updateJobStatus('recent-running', 'running');

    const deleted = store.gcJobs({
      failedDispatchOlderThanMs: 7 * 24 * 60 * 60 * 1000,
      completedOlderThanMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(deleted).toBe(1);
    expect(store.listOpenJobs().map((j) => j.job_id)).toEqual(['recent-running']);
    store.close();
  });
});

describe('CoordinatorStore.listOpenJobs', () => {
  it('honors the limit argument', () => {
    const store = freshStore();
    const a = store.registerAgent({
      name: 'tinkerer-1',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://x:8080',
      supported_methods: ['plan'],
    });
    for (let i = 1; i <= 5; i++) {
      store.insertJob({
        job_id: `j_${i}`,
        agent_id: a.agent_id,
      persona_name: 'tinkerer',
        method: 'plan',
        repo: 'acme/api',
        target_id: i,
        status: 'dispatched',
        dispatched_at: Date.now() + i,
      });
    }
    expect(store.listOpenJobs(2)).toHaveLength(2);
    expect(store.listOpenJobs()).toHaveLength(5);
    store.close();
  });
});

describe('CoordinatorStore.recordHeartbeat', () => {
  it('returns true when the agent exists', () => {
    const store = freshStore();
    const a = store.registerAgent({
      name: 'x',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://x:8080',
      supported_methods: ['plan'],
    });
    expect(store.recordHeartbeat(a.agent_id, 'BUSY')).toBe(true);
    store.close();
  });

  it('returns false when no row matches — used by /heartbeat to short-circuit a separate getAgent', () => {
    const store = freshStore();
    expect(store.recordHeartbeat('does-not-exist', 'IDLE')).toBe(false);
    store.close();
  });
});

describe('agents.supported_methods CHECK constraint (migration 5)', () => {
  it('rejects non-JSON values at the DB layer so pickIdleAgent never trips on json_each', () => {
    const store = freshStore();
    const db = (store as unknown as { db: Database.Database }).db;
    expect(() =>
      db
        .prepare(
          `INSERT INTO agents (agent_id, name, type, version, url, supported_methods, registered_at, last_heartbeat, last_known_status)
           VALUES ('a1', 'rogue', 'tinkerer', '0.1.0', 'http://x', 'not-json', 0, 0, 'IDLE')`,
        )
        .run(),
    ).toThrow();
    store.close();
  });

  it('accepts valid JSON arrays', () => {
    const store = freshStore();
    const db = (store as unknown as { db: Database.Database }).db;
    expect(() =>
      db
        .prepare(
          `INSERT INTO agents (agent_id, name, type, version, url, supported_methods, registered_at, last_heartbeat, last_known_status)
           VALUES ('a1', 'ok', 'tinkerer', '0.1.0', 'http://x', '["plan","implement"]', 0, 0, 'IDLE')`,
        )
        .run(),
    ).not.toThrow();
    store.close();
  });
});

describe('CoordinatorStore.deleteAgent', () => {
  it('marks active jobs as failed/orphaned so hasActiveJob unblocks future dispatch', () => {
    // Without the fixup, deleting an agent leaves dispatched/running jobs
    // in the table. They never get cleaned up (gcJobs ignores active states;
    // job-poller only sees living agents) so hasActiveJob would return true
    // for the same (repo, method, target_id) forever.
    const store = freshStore();
    const a = store.registerAgent({
      name: 'tinkerer-1',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://x:8080',
      supported_methods: ['plan'],
    });
    store.insertJob({
      job_id: 'j_1',
      agent_id: a.agent_id,
      persona_name: 'tinkerer',
      method: 'plan',
      repo: 'acme/api',
      target_id: 7,
      status: 'dispatched',
      dispatched_at: Date.now(),
    });
    store.updateJobStatus('j_1', 'running');
    expect(store.hasActiveJob('acme/api', 'tinkerer', 'plan', 7)).toBe(true);

    expect(store.deleteAgent(a.agent_id)).toBe(true);

    // Active job should now be terminal (status='failed', outcome='orphaned'),
    // and hasActiveJob should return false so future dispatch isn't blocked.
    expect(store.hasActiveJob('acme/api', 'tinkerer', 'plan', 7)).toBe(false);
    const recent = store.listRecentJobs();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.status).toBe('failed');
    expect(recent[0]?.outcome).toBe('orphaned');
    store.close();
  });

  it('returns false when the agent does not exist', () => {
    const store = freshStore();
    expect(store.deleteAgent('does-not-exist')).toBe(false);
    store.close();
  });

  it('does not touch terminal jobs (complete/failed/failed_to_dispatch) of the deleted agent', () => {
    const store = freshStore();
    const a = store.registerAgent({
      name: 'x',
      type: 'tinkerer',
      version: '0.1.0',
      url: 'http://x:8080',
      supported_methods: ['plan'],
    });
    store.insertJob({
      job_id: 'j_done',
      agent_id: a.agent_id,
      persona_name: 'tinkerer',
      method: 'plan',
      repo: 'acme/api',
      target_id: 1,
      status: 'dispatched',
      dispatched_at: Date.now(),
    });
    store.updateJobStatus('j_done', 'complete', { outcome: 'success', completed_at: Date.now() });

    store.deleteAgent(a.agent_id);

    const recent = store.listRecentJobs();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.outcome).toBe('success'); // unchanged
    store.close();
  });
});

describe('agents.type CHECK constraint (migration 2)', () => {
  it('rejects unknown persona types at the DB layer', () => {
    const store = freshStore();
    // Use the underlying DB directly to bypass Zod and exercise the CHECK.
    const db = (store as unknown as { db: Database.Database }).db;
    expect(() =>
      db
        .prepare(
          `INSERT INTO agents (agent_id, name, type, version, url, supported_methods, registered_at, last_heartbeat, last_known_status)
           VALUES ('a1', 'rogue', 'not_a_persona', '0.1.0', 'http://x', '[]', 0, 0, 'IDLE')`,
        )
        .run(),
    ).toThrow();
    store.close();
  });

  it('accepts each builtin persona', () => {
    const store = freshStore();
    for (const persona of ['orchestrator', 'tinkerer', 'custom'] as const) {
      const a = store.registerAgent({
        name: `agent-${persona}`,
        type: persona,
        version: '0.1.0',
        url: `http://${persona}:8080`,
        supported_methods: ['plan'],
      });
      expect(a.type).toBe(persona);
    }
    store.close();
  });
});

describe('CoordinatorStore plans (migration 8)', () => {
  it('upsertPlan inserts a plan and listOpenPlans returns it', () => {
    const store = freshStore();
    store.upsertPlan('acme/api', 10, [11, 12, 13]);
    const open = store.listOpenPlans();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ repo: 'acme/api', parent_id: 10, child_ids: [11, 12, 13] });
    store.close();
  });

  it('re-upsert overwrites child_ids and resets completed_at to NULL', () => {
    const store = freshStore();
    store.upsertPlan('acme/api', 10, [11, 12]);
    store.markPlanComplete('acme/api', 10);
    // Verify it's gone from open list before re-plan
    expect(store.listOpenPlans()).toHaveLength(0);

    store.upsertPlan('acme/api', 10, [11, 12, 13]);
    const open = store.listOpenPlans();
    expect(open).toHaveLength(1);
    expect(open[0]?.child_ids).toEqual([11, 12, 13]);
    store.close();
  });

  it('markPlanComplete excludes the row from listOpenPlans', () => {
    const store = freshStore();
    store.upsertPlan('acme/api', 10, [11]);
    store.upsertPlan('acme/api', 20, [21, 22]);
    store.markPlanComplete('acme/api', 10);
    const open = store.listOpenPlans();
    expect(open).toHaveLength(1);
    expect(open[0]?.parent_id).toBe(20);
    store.close();
  });

  it('markPlanComplete is idempotent', () => {
    const store = freshStore();
    store.upsertPlan('acme/api', 10, [11]);
    store.markPlanComplete('acme/api', 10);
    expect(() => store.markPlanComplete('acme/api', 10)).not.toThrow();
    expect(store.listOpenPlans()).toHaveLength(0);
    store.close();
  });

  it('recordPlanCheck updates last_checked_at', () => {
    const store = freshStore();
    const t1 = Date.now();
    store.upsertPlan('acme/api', 10, [11]);
    const before = store.listOpenPlans()[0];
    expect(before?.last_checked_at).toBeNull();

    store.recordPlanCheck('acme/api', 10, t1);
    const after = store.listOpenPlans()[0];
    expect(after?.last_checked_at).toBe(t1);
    store.close();
  });
});
