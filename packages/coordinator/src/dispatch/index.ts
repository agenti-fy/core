import { ulid } from 'ulid';
import type { Logger } from 'pino';
import type { CoordinatorStore } from '../store.js';
import type { AgentRpcClient } from '../agent-client.js';
import type { CoordinatorMetrics } from '../metrics.js';
import { compareMethodsByPriority } from '@agenti-fy/shared';
import { requestFullScanForRepo, type PendingWorkItem } from '../poller/work-poller.js';

export interface DispatchDeps {
  store: CoordinatorStore;
  agentClient: AgentRpcClient;
  logger: Logger;
  metrics?: CoordinatorMetrics;
}

export interface DispatchSummary {
  considered: number;
  dispatched: number;
  no_agent: number;
  busy: number;
  /** Sum of agent-self-FAILURE + method_not_supported + 4xx-rejected + transport_error.
   *  Convenience aggregate; the four narrower counters below are the truth. */
  failed: number;
  failure: number;
  method_not_supported: number;
  rejected: number;
  transport_error: number;
  skipped_active: number;
  skipped_collision: number;
  /** Items left unprocessed because POST /halt landed mid-batch. Without this
   *  counter, `considered` minus the rest of the columns silently goes
   *  unexplained when an operator halts during a long batch. */
  halted_skipped: number;
}

/**
 * Process a batch of pending work items. For each item:
 *   1. Skip if there's already an active job for this target.
 *   2. Find an IDLE agent matching the persona AND supporting the method.
 *   3. Insert a job row and POST to the agent's /<method> endpoint.
 *   4. Persist the resulting status (running / failed_to_dispatch).
 *
 * Rejection-marking policy: we only update local heartbeat status on a
 * positive accept (202 → BUSY) or a definitive transport/method failure. A
 * 409 from the agent indicates *its* state is BUSY; we record that. A 503
 * means the agent self-reported FAILURE; we record that. We do NOT optimistically
 * mark the agent unavailable for any other reason — the next /status poll
 * is the authoritative source.
 */
export async function dispatchBatch(
  items: readonly PendingWorkItem[],
  deps: DispatchDeps,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    considered: items.length,
    dispatched: 0,
    no_agent: 0,
    busy: 0,
    failed: 0,
    failure: 0,
    method_not_supported: 0,
    rejected: 0,
    transport_error: 0,
    skipped_active: 0,
    skipped_collision: 0,
    halted_skipped: 0,
  };

  // Group by repo so we can run cross-repo dispatches in parallel while keeping
  // same-repo dispatches serialized (agent can only be BUSY on one job at a time).
  const byRepo = new Map<string, PendingWorkItem[]>();
  for (const item of items) {
    const list = byRepo.get(item.repo) ?? [];
    list.push(item);
    byRepo.set(item.repo, list);
  }

  // Sort each repo bucket by (method-priority DESC, target_id ASC, persona_name ASC)
  // so that lifecycle-late work drains before lifecycle-early work begins (#408):
  //   merge > address_review > review > implement > plan   ← method priority (primary)
  //   lower target_id wins within a method                 ← FIFO tiebreaker (secondary)
  //   alphabetical persona_name within same method + id    ← deterministic tiebreaker (tertiary)
  for (const bucket of byRepo.values()) {
    bucket.sort(
      (a, b) =>
        compareMethodsByPriority(a.method, b.method) ||
        a.target_id - b.target_id ||
        a.persona_name.localeCompare(b.persona_name),
    );
  }

  await Promise.all(
    [...byRepo.values()].map((repoItems) => dispatchRepoBatch(repoItems, deps, summary)),
  );

  return summary;
}

async function dispatchRepoBatch(
  items: readonly PendingWorkItem[],
  deps: DispatchDeps,
  summary: DispatchSummary,
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    // Honor halt requested mid-batch. Without this check, a POST /halt during
    // a long dispatchBatch keeps dispatching for the whole batch — operator's
    // halt only takes effect on the next work-poll tick, which surprises them.
    if (deps.store.isHalted()) {
      summary.halted_skipped += items.length - i;
      return;
    }
    if (deps.store.hasActiveJob(item.repo, item.persona_name, item.method, item.target_id)) {
      summary.skipped_active++;
      continue;
    }

    const agent = deps.store.pickIdleAgentForPersona(item.persona_name, item.method);
    if (!agent) {
      summary.no_agent++;
      // Items skipped due to no_agent would otherwise stay invisible to the
      // work-poller's since= filter until the next periodic full scan, since
      // their updated_at doesn't move. Flag the repo so the next tick does
      // a full scan and re-picks them up once an agent goes IDLE.
      requestFullScanForRepo(item.repo);
      deps.logger.debug(
        { repo: item.repo, target: item.target_id, method: item.method, persona: item.persona_name },
        'no idle agent for persona/method',
      );
      continue;
    }

    // Reserve the agent BEFORE the await on the dispatch HTTP. Without this,
    // a parallel dispatchRepoBatch (different repo, same persona) running via
    // Promise.all in dispatchBatch would also see this agent as IDLE and
    // double-pick it, producing a 409 BUSY collision and a wasted dispatch.
    // Reverted to IDLE below in the rejected/method_not_supported/transport_error
    // cases where the agent didn't actually go BUSY.
    deps.store.recordHeartbeat(agent.agent_id, 'BUSY');

    const job_id = `j_${ulid()}`;
    try {
      deps.store.insertJob({
        job_id,
        agent_id: agent.agent_id,
        method: item.method,
        repo: item.repo,
        target_id: item.target_id,
        persona_name: item.persona_name,
        status: 'dispatched',
        dispatched_at: Date.now(),
      });
    } catch (err) {
      // Most likely the partial unique index — another concurrent insert won.
      // Revert the BUSY reservation so the agent isn't left flagged BUSY in
      // the DB without a corresponding running job; otherwise the dispatcher
      // would skip this agent until the next /status poll reconciles.
      deps.store.recordHeartbeat(agent.agent_id, 'IDLE');
      summary.skipped_collision++;
      deps.logger.debug(
        { repo: item.repo, target: item.target_id, method: item.method, err: String(err) },
        'insert collided with active job',
      );
      continue;
    }

    const dispatchStart = Date.now();
    const outcome = await deps.agentClient.dispatch(agent.url, item.method, {
      job_id,
      repo: item.repo,
      id: item.target_id,
      session_id: deps.store.getSession(agent.agent_id, item.repo),
      persona_name: item.persona_name,
    });
    deps.metrics?.recordDispatch(item.method, outcome.kind, Date.now() - dispatchStart);

    switch (outcome.kind) {
      case 'accepted':
        deps.store.updateJobStatus(job_id, 'running');
        deps.store.recordHeartbeat(agent.agent_id, 'BUSY');
        deps.logger.info(
          {
            job_id,
            agent_id: agent.agent_id,
            agent: agent.name,
            method: item.method,
            repo: item.repo,
            target: item.target_id,
          },
          'dispatched',
        );
        summary.dispatched++;
        break;
      case 'busy':
        // Agent legitimately busy (we dispatched against stale heartbeat).
        // Reflect what the agent told us.
        deps.store.updateJobStatus(job_id, 'failed_to_dispatch');
        deps.store.recordHeartbeat(agent.agent_id, 'BUSY');
        summary.busy++;
        break;
      case 'failure':
        // Agent self-reported FAILURE.
        deps.store.updateJobStatus(job_id, 'failed_to_dispatch');
        deps.store.recordHeartbeat(agent.agent_id, 'FAILURE');
        summary.failure++;
        summary.failed++;
        break;
      case 'method_not_supported':
        // The supported_methods filter should have prevented this; log loudly.
        // Agent refused without going BUSY — undo the reservation so the next
        // tick can try a different method on the same agent.
        deps.store.updateJobStatus(job_id, 'failed_to_dispatch');
        deps.store.recordHeartbeat(agent.agent_id, 'IDLE');
        deps.logger.warn(
          { agent_id: agent.agent_id, method: item.method, supported: agent.supported_methods },
          'agent rejected unsupported method (filter mismatch)',
        );
        summary.method_not_supported++;
        summary.failed++;
        break;
      case 'rejected':
        // Definitive 4xx from the agent (e.g., schema validation). The agent
        // saw the request and refused; nothing to reconcile. Undo the BUSY
        // reservation since the agent didn't actually go BUSY.
        deps.store.updateJobStatus(job_id, 'failed_to_dispatch');
        deps.store.recordHeartbeat(agent.agent_id, 'IDLE');
        deps.logger.warn(
          {
            agent_id: agent.agent_id,
            url: agent.url,
            method: item.method,
            statusCode: outcome.statusCode,
            err: outcome.message,
          },
          'agent rejected dispatch (4xx)',
        );
        summary.rejected++;
        summary.failed++;
        break;
      case 'transport_error':
        // Ambiguous: the agent may have received the request and started
        // running, or may not have. Leave the job in 'dispatched' state and
        // let pollJobCompletions reconcile via /status + /jobs/:id. Marking
        // failed_to_dispatch here would terminate the row before the agent's
        // outcome arrives, orphaning a possibly-running job. Revert the BUSY
        // reservation to IDLE conservatively — if the agent did receive the
        // request and is running, the next /status poll restores BUSY; if it
        // didn't, we don't pessimistically lock it out from new dispatches.
        deps.store.recordHeartbeat(agent.agent_id, 'IDLE');
        deps.logger.warn(
          {
            agent_id: agent.agent_id,
            url: agent.url,
            method: item.method,
            err: outcome.message,
          },
          'transport error dispatching — leaving job dispatched, status poll will reconcile',
        );
        summary.transport_error++;
        summary.failed++;
        break;
    }
  }
}
