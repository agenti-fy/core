import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';
import type { Method } from '@agentify/shared';
import { CoordinatorStore } from '../store.js';
import type { DispatchOutcome } from '../agent-client.js';
import { CoordinatorMetrics } from '../metrics.js';
import { dispatchBatch } from './index.js';
import type { PendingWorkItem } from '../poller/work-poller.js';

const silentLog: Logger = pino({ level: 'silent' });

function freshStore(): CoordinatorStore {
  const dir = mkdtempSync(join(tmpdir(), 'agentify-dispatch-'));
  return new CoordinatorStore(join(dir, 'test.db'));
}

class FakeAgentClient {
  outcomes: DispatchOutcome[] = [];
  calls: Array<{ url: string; method: Method; body: { job_id: string } }> = [];
  push(o: DispatchOutcome): void { this.outcomes.push(o); }
  async dispatch(url: string, method: Method, body: { job_id: string }): Promise<DispatchOutcome> {
    this.calls.push({ url, method, body });
    return this.outcomes.shift() ?? { kind: 'transport_error', message: 'no fake outcome' };
  }
  async getStatus(): Promise<never> { throw new Error('not used in dispatch tests'); }
  async getJob(): Promise<never> { throw new Error('not used in dispatch tests'); }
  async reset(): Promise<never> { throw new Error('not used in dispatch tests'); }
}

function workItem(over: Partial<PendingWorkItem> = {}): PendingWorkItem {
  return {
    repo: 'acme/api',
    target_id: 1,
    persona: 'tinkerer',
    persona_name: 'tinkerer',
    method: 'plan',
    ...over,
  };
}

function regAgent(store: CoordinatorStore, name = 'tinkerer-1', methods: Method[] = ['plan', 'implement']) {
  return store.registerAgent({
    name,
    type: 'tinkerer',
    version: '0.1.0',
    url: `http://${name}:8080`,
    supported_methods: methods,
  });
}

describe('dispatchBatch', () => {
  let store: CoordinatorStore;
  let client: FakeAgentClient;

  beforeEach(() => {
    store = freshStore();
    client = new FakeAgentClient();
  });

  it('marks job running and agent BUSY on accept', async () => {
    const a = regAgent(store);
    client.push({ kind: 'accepted', data: { job_id: 'ignored', agent_id: a.agent_id,
      status: 'BUSY' } });

    const summary = await dispatchBatch([workItem()], {
      store,
      agentClient: client,
      logger: silentLog,
    });

    expect(summary.dispatched).toBe(1);
    expect(summary.failed).toBe(0);
    expect(store.getAgent(a.agent_id)?.last_known_status).toBe('BUSY');
    const open = store.listOpenJobs();
    expect(open).toHaveLength(1);
    expect(open[0]?.status).toBe('running');
    store.close();
  });

  it('skips items where an active job already exists', async () => {
    const a = regAgent(store);
    store.insertJob({
      job_id: 'pre-existing',
      agent_id: a.agent_id,
      persona_name: 'tinkerer',
      method: 'plan',
      repo: 'acme/api',
      target_id: 42,
      status: 'running',
      dispatched_at: Date.now(),
    });

    const summary = await dispatchBatch([workItem({ target_id: 42 })], {
      store,
      agentClient: client,
      logger: silentLog,
    });

    expect(summary.skipped_active).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(client.calls).toHaveLength(0);
    store.close();
  });

  it('counts no_agent when no IDLE agent supports the method', async () => {
    regAgent(store, 'tinkerer-1', ['plan']);
    const summary = await dispatchBatch([workItem({ method: 'merge' })], {
      store,
      agentClient: client,
      logger: silentLog,
    });
    expect(summary.no_agent).toBe(1);
    expect(summary.dispatched).toBe(0);
    store.close();
  });

  it('marks job failed_to_dispatch and agent BUSY when agent reports busy', async () => {
    const a = regAgent(store);
    client.push({ kind: 'busy', current_job_id: 'other' });

    const summary = await dispatchBatch([workItem()], {
      store,
      agentClient: client,
      logger: silentLog,
    });

    expect(summary.busy).toBe(1);
    expect(store.getAgent(a.agent_id)?.last_known_status).toBe('BUSY');
    expect(store.listOpenJobs()).toHaveLength(0);
    store.close();
  });

  it('marks agent FAILURE when agent reports failure', async () => {
    const a = regAgent(store);
    client.push({ kind: 'failure' });

    await dispatchBatch([workItem()], {
      store,
      agentClient: client,
      logger: silentLog,
    });

    expect(store.getAgent(a.agent_id)?.last_known_status).toBe('FAILURE');
    store.close();
  });

  it('rejected (4xx): marks failed_to_dispatch immediately (definitive refusal)', async () => {
    const a = regAgent(store);
    client.push({ kind: 'rejected', statusCode: 400, message: '400: bad body' });

    const summary = await dispatchBatch([workItem()], {
      store,
      agentClient: client,
      logger: silentLog,
    });

    expect(summary.failed).toBe(1);
    expect(store.getAgent(a.agent_id)?.last_known_status).toBe('IDLE');
    expect(store.listOpenJobs()).toHaveLength(0);
    store.close();
  });

  it('records dispatch outcomes in metrics', async () => {
    const a = regAgent(store);
    const metrics = new CoordinatorMetrics();
    client.push({ kind: 'accepted', data: { job_id: 'x', agent_id: a.agent_id,
      status: 'BUSY' } });

    await dispatchBatch([workItem()], {
      store,
      agentClient: client,
      logger: silentLog,
      metrics,
    });

    const text = await metrics.registry.metrics();
    // Counter line should reflect a single accepted dispatch on plan. Label
    // order is library-dependent — assert presence with two lookaheads.
    expect(text).toMatch(
      /agentify_dispatched_total\{(?=[^}]*method="plan")(?=[^}]*kind="accepted")[^}]*\} 1/,
    );
    store.close();
  });

  it('transport_error: leaves job dispatched and agent status alone (status poll will reconcile)', async () => {
    const a = regAgent(store);
    expect(store.getAgent(a.agent_id)?.last_known_status).toBe('IDLE');
    client.push({ kind: 'transport_error', message: 'ECONNREFUSED' });

    const summary = await dispatchBatch([workItem()], {
      store,
      agentClient: client,
      logger: silentLog,
    });

    expect(summary.failed).toBe(1);
    expect(store.getAgent(a.agent_id)?.last_known_status).toBe('IDLE');
    // Job remains in 'dispatched' state — pollJobCompletions reconciles via
    // /status + /jobs/:id rather than terminating the row prematurely.
    const open = store.listOpenJobs();
    expect(open).toHaveLength(1);
    expect(open[0]?.status).toBe('dispatched');
    store.close();
  });

  it('reserves agent before HTTP await: parallel cross-repo dispatches do not double-pick', async () => {
    // Single tinkerer agent, two different repos. Without the BUSY reservation
    // before the dispatch await, both Promise.all branches pick the same IDLE
    // agent and produce one accepted + one busy collision. With the fix, the
    // second branch sees BUSY in the DB and reports no_agent.
    const a = regAgent(store);
    client.push({ kind: 'accepted', data: { job_id: 'a', agent_id: a.agent_id,
      status: 'BUSY' } });
    client.push({ kind: 'accepted', data: { job_id: 'b', agent_id: a.agent_id,
      status: 'BUSY' } });

    const summary = await dispatchBatch(
      [
        workItem({ repo: 'acme/api', target_id: 1 }),
        workItem({ repo: 'acme/web', target_id: 1 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    expect(summary.dispatched).toBe(1);
    expect(summary.no_agent).toBe(1);
    expect(client.calls).toHaveLength(1);
    store.close();
  });

  it('combined-label routing: same PR + multiple reviewers → distinct concurrent jobs', async () => {
    // The motivating case for combined-label routing. A PR with both
    // `agent:conductor:review` and `agent:skeptic:review` produces two work
    // items keyed on (persona, method, target). Both insert successfully —
    // the per-persona partial unique index doesn't collide — and each
    // dispatches to its own agent.
    const conductor = store.registerAgent({
      name: 'conductor',
      type: 'conductor',
      version: '0.1.0',
      url: 'http://conductor:8080',
      supported_methods: ['review'],
    });
    const skeptic = store.registerAgent({
      name: 'skeptic',
      type: 'skeptic',
      version: '0.1.0',
      url: 'http://skeptic:8080',
      supported_methods: ['review'],
    });
    client.push({ kind: 'accepted', data: { job_id: 'c', agent_id: conductor.agent_id, status: 'BUSY' } });
    client.push({ kind: 'accepted', data: { job_id: 's', agent_id: skeptic.agent_id, status: 'BUSY' } });

    const summary = await dispatchBatch(
      [
        workItem({ persona: 'conductor', persona_name: 'conductor', method: 'review', target_id: 42 }),
        workItem({ persona: 'skeptic', persona_name: 'skeptic', method: 'review', target_id: 42 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    expect(summary.dispatched).toBe(2);
    expect(summary.skipped_collision).toBe(0);
    const open = store.listOpenJobs();
    expect(open.map((j) => j.persona_name).sort()).toEqual(['conductor', 'skeptic']);
    store.close();
  });

  it('halts mid-batch and counts unprocessed items in halted_skipped', async () => {
    const a = regAgent(store);
    client.push({ kind: 'accepted', data: { job_id: 'x', agent_id: a.agent_id,
      status: 'BUSY' } });
    // Halt fires after the first item is dispatched: the agent's BUSY flip
    // means the second item would no_agent anyway, but we want to assert the
    // halt path specifically. Pre-halt the store so the FIRST item bails.
    store.setHalted(true);

    const summary = await dispatchBatch(
      [
        workItem({ repo: 'acme/api', target_id: 1 }),
        workItem({ repo: 'acme/api', target_id: 2 }),
        workItem({ repo: 'acme/api', target_id: 3 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    expect(summary.halted_skipped).toBe(3);
    expect(summary.dispatched).toBe(0);
    expect(client.calls).toHaveLength(0);
    store.close();
  });

  it('sorts items within a repo bucket by target_id ASC: lowest id dispatched first', async () => {
    // Single IDLE tinkerer + three items in one repo arriving out-of-order.
    // After the sort, target 2 should be the first (and only) call made.
    const a = regAgent(store);
    client.push({ kind: 'accepted', data: { job_id: 'x', agent_id: a.agent_id, status: 'BUSY' } });

    await dispatchBatch(
      [
        workItem({ target_id: 7 }),
        workItem({ target_id: 2 }),
        workItem({ target_id: 5 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    expect(client.calls).toHaveLength(1);
    expect((client.calls[0]!.body as { job_id: string; id: number }).id).toBe(2);
    store.close();
  });

  it('sorts mixed-persona items by target_id ASC: lower target dispatched before higher', async () => {
    // skeptic + scribe agents, items at target_id [5, 5, 3]. After sort the
    // target:3 item comes first; the two target:5 items follow.
    const skeptic = store.registerAgent({
      name: 'skeptic-1',
      type: 'skeptic',
      version: '0.1.0',
      url: 'http://skeptic-1:8080',
      supported_methods: ['review'],
    });
    const scribe = store.registerAgent({
      name: 'scribe-1',
      type: 'scribe',
      version: '0.1.0',
      url: 'http://scribe-1:8080',
      supported_methods: ['review'],
    });
    client.push({ kind: 'accepted', data: { job_id: 'sk3', agent_id: skeptic.agent_id, status: 'BUSY' } });
    client.push({ kind: 'accepted', data: { job_id: 'sc5', agent_id: scribe.agent_id, status: 'BUSY' } });

    await dispatchBatch(
      [
        workItem({ persona: 'skeptic', persona_name: 'skeptic', method: 'review', target_id: 5 }),
        workItem({ persona: 'scribe',  persona_name: 'scribe',  method: 'review', target_id: 5 }),
        workItem({ persona: 'skeptic', persona_name: 'skeptic', method: 'review', target_id: 3 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    // target:3 must appear before any target:5 call
    const ids = client.calls.map((c) => (c.body as { job_id: string; id: number }).id);
    expect(ids[0]).toBe(3);
    expect(ids.indexOf(5)).toBeGreaterThan(0);
    store.close();
  });

  it('sorts per-repo independently: a/x sorts by target_id without regard to b/y', async () => {
    // Three tinkerer agents cover all three dispatches. Input order has a/x
    // items out-of-order ([9, 2]); after per-bucket sort they become [2, 9].
    const a1 = regAgent(store, 'tinkerer-1');
    const a2 = regAgent(store, 'tinkerer-2');
    const a3 = regAgent(store, 'tinkerer-3');
    client.push({ kind: 'accepted', data: { job_id: 'j1', agent_id: a1.agent_id, status: 'BUSY' } });
    client.push({ kind: 'accepted', data: { job_id: 'j2', agent_id: a2.agent_id, status: 'BUSY' } });
    client.push({ kind: 'accepted', data: { job_id: 'j3', agent_id: a3.agent_id, status: 'BUSY' } });

    await dispatchBatch(
      [
        workItem({ repo: 'a/x', target_id: 9 }),
        workItem({ repo: 'b/y', target_id: 1 }),
        workItem({ repo: 'a/x', target_id: 2 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    expect(client.calls).toHaveLength(3);
    type BodyShape = { job_id: string; repo: string; id: number };
    // Within a/x, target:2 must have been dispatched before target:9.
    const axIds = client.calls
      .filter((c) => (c.body as unknown as BodyShape).repo === 'a/x')
      .map((c) => (c.body as unknown as BodyShape).id);
    expect(axIds).toEqual([2, 9]);
    // b/y dispatched its one item independently.
    const byIds = client.calls
      .filter((c) => (c.body as unknown as BodyShape).repo === 'b/y')
      .map((c) => (c.body as unknown as BodyShape).id);
    expect(byIds).toEqual([1]);
    store.close();
  });

  it('serializes same-repo dispatches: second item gets no_agent once first has flipped to BUSY', async () => {
    const a = regAgent(store);
    // Only one accept available; second same-repo dispatch should find no IDLE agent.
    client.push({ kind: 'accepted', data: { job_id: 'x', agent_id: a.agent_id,
      status: 'BUSY' } });

    const summary = await dispatchBatch(
      [
        workItem({ repo: 'acme/api', target_id: 1 }),
        workItem({ repo: 'acme/api', target_id: 2 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    expect(summary.dispatched).toBe(1);
    expect(summary.no_agent).toBe(1);
    expect(client.calls).toHaveLength(1);
    store.close();
  });

  // ── lifecycle-priority tests (issue #408) ─────────────────────────────────

  it('merge beats plan despite higher target_id: method priority is primary key', async () => {
    // One agent supporting both plan and merge. Two items: plan at target_id 5
    // (lower id, old sort would have dispatched this first) and merge at
    // target_id 500 (higher id). After the new sort, merge wins on priority.
    const a = regAgent(store, 'tinkerer-1', ['plan', 'merge']);
    client.push({ kind: 'accepted', data: { job_id: 'm1', agent_id: a.agent_id, status: 'BUSY' } });

    await dispatchBatch(
      [
        workItem({ method: 'plan', target_id: 5 }),
        workItem({ method: 'merge', target_id: 500 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    // Only one accept was queued, so exactly one dispatch happened.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe('merge');
    expect((client.calls[0]!.body as { job_id: string; id: number }).id).toBe(500);
    store.close();
  });

  it('full lifecycle ordering: merge → address_review → review → implement → plan', async () => {
    // Five agents, one per method/persona. Items queued in shuffled order.
    // After sort, client.calls should reflect lifecycle-late-first order.
    const agents = {
      glue:     store.registerAgent({ name: 'glue-1',     type: 'glue',     version: '0.1.0', url: 'http://glue-1:8080',     supported_methods: ['merge'] }),
      scribe:   store.registerAgent({ name: 'scribe-1',   type: 'scribe',   version: '0.1.0', url: 'http://scribe-1:8080',   supported_methods: ['address_review'] }),
      skeptic:  store.registerAgent({ name: 'skeptic-1',  type: 'skeptic',  version: '0.1.0', url: 'http://skeptic-1:8080',  supported_methods: ['review'] }),
      theorist: store.registerAgent({ name: 'theorist-1', type: 'theorist', version: '0.1.0', url: 'http://theorist-1:8080', supported_methods: ['implement'] }),
      tinkerer: regAgent(store, 'tinkerer-1', ['plan']),
    };
    // Push one accept per agent (order doesn't matter — they're distinct agents).
    client.push({ kind: 'accepted', data: { job_id: 'j-glue',     agent_id: agents.glue.agent_id,     status: 'BUSY' } });
    client.push({ kind: 'accepted', data: { job_id: 'j-scribe',   agent_id: agents.scribe.agent_id,   status: 'BUSY' } });
    client.push({ kind: 'accepted', data: { job_id: 'j-skeptic',  agent_id: agents.skeptic.agent_id,  status: 'BUSY' } });
    client.push({ kind: 'accepted', data: { job_id: 'j-theorist', agent_id: agents.theorist.agent_id, status: 'BUSY' } });
    client.push({ kind: 'accepted', data: { job_id: 'j-tinkerer', agent_id: agents.tinkerer.agent_id, status: 'BUSY' } });

    // Enqueue items in shuffled method order to prove the sort is what drives the outcome.
    await dispatchBatch(
      [
        workItem({ persona: 'tinkerer', persona_name: 'tinkerer', method: 'plan',           target_id: 1 }),
        workItem({ persona: 'skeptic',  persona_name: 'skeptic',  method: 'review',         target_id: 2 }),
        workItem({ persona: 'glue',     persona_name: 'glue',     method: 'merge',          target_id: 3 }),
        workItem({ persona: 'theorist', persona_name: 'theorist', method: 'implement',      target_id: 4 }),
        workItem({ persona: 'scribe',   persona_name: 'scribe',   method: 'address_review', target_id: 5 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    expect(client.calls).toHaveLength(5);
    const dispatchedMethods = client.calls.map((c) => c.method);
    expect(dispatchedMethods).toEqual(['merge', 'address_review', 'review', 'implement', 'plan']);
    store.close();
  });

  it('target_id is the secondary tiebreaker within a method: lowest id dispatched first', async () => {
    // Three merge items in the same repo. After sort: target_id 5 → 50 → 100.
    // With one accept queued, only target_id 5 gets dispatched.
    const a = regAgent(store, 'tinkerer-1', ['merge']);
    client.push({ kind: 'accepted', data: { job_id: 'm5', agent_id: a.agent_id, status: 'BUSY' } });

    await dispatchBatch(
      [
        workItem({ method: 'merge', target_id: 100 }),
        workItem({ method: 'merge', target_id: 5 }),
        workItem({ method: 'merge', target_id: 50 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    expect(client.calls).toHaveLength(1);
    expect((client.calls[0]!.body as { job_id: string; id: number }).id).toBe(5);
    store.close();
  });

  it('cross-method strictly beats cross-id: merge:999 dispatched before plan:1', async () => {
    // plan at target_id 1 (lower id) vs merge at target_id 999 (higher id).
    // The old sort would have dispatched plan:1 first. The new sort must
    // dispatch merge:999 first because method priority is the primary key.
    const a = regAgent(store, 'tinkerer-1', ['plan', 'merge']);
    client.push({ kind: 'accepted', data: { job_id: 'mj', agent_id: a.agent_id, status: 'BUSY' } });

    await dispatchBatch(
      [
        workItem({ method: 'plan',  target_id: 1 }),
        workItem({ method: 'merge', target_id: 999 }),
      ],
      { store, agentClient: client, logger: silentLog },
    );

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe('merge');
    expect((client.calls[0]!.body as { job_id: string; id: number }).id).toBe(999);
    store.close();
  });
});
