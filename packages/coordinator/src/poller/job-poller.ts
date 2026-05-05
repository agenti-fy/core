import type { Logger } from 'pino';
import type { JobRecord } from '@agentify/shared';
import type { CoordinatorStore } from '../store.js';
import type { AgentRpcClient, GetJobResult } from '../agent-client.js';
import type { CoordinatorMetrics } from '../metrics.js';

export interface JobPollerDeps {
  store: CoordinatorStore;
  agentClient: AgentRpcClient;
  logger: Logger;
  metrics?: CoordinatorMetrics;
}

/**
 * Poll every registered agent's /status concurrently. For each running job,
 * detect BUSY→IDLE transitions and persist the result.
 */
export async function pollJobCompletions(deps: JobPollerDeps): Promise<void> {
  const agents = deps.store.listAgents();
  await Promise.allSettled(agents.map((agent) => pollOneAgent(agent, deps)));
}

async function pollOneAgent(
  agent: { agent_id: string; url: string },
  deps: JobPollerDeps,
): Promise<void> {
  let status;
  try {
    status = await deps.agentClient.getStatus(agent.url);
  } catch (err) {
    deps.logger.debug(
      { agent_id: agent.agent_id, err: err instanceof Error ? err.message : String(err) },
      'agent /status unreachable',
    );
    return;
  }

  deps.store.recordHeartbeat(agent.agent_id, status.status);

  const open = deps.store.listRunningJobsForAgent(agent.agent_id);
  if (open.length === 0) return;

  // Reconcile each job in parallel. A pile of stuck jobs (e.g. after a crash)
  // would otherwise serialize 10s timeouts for every one. Each reconcile is
  // independent — they all hit the same agent's endpoints but undici handles
  // the connection multiplexing.
  await Promise.allSettled(
    open.map((job) => reconcileJob(agent, status, job, deps)),
  );
}

async function reconcileJob(
  agent: { agent_id: string; url: string },
  status: { current_job: { id: string } | null },
  job: JobRecord,
  deps: JobPollerDeps,
): Promise<void> {
  if (status.current_job && status.current_job.id === job.job_id) {
    if (job.status === 'dispatched') {
      deps.store.updateJobStatus(job.job_id, 'running');
    }
    return;
  }

  let job_result: GetJobResult;
  try {
    job_result = await deps.agentClient.getJob(agent.url, job.job_id);
  } catch (err) {
    deps.logger.warn(
      {
        agent_id: agent.agent_id,
        job_id: job.job_id,
        err: err instanceof Error ? err.message : String(err),
      },
      'failed to fetch /jobs/:id',
    );
    return;
  }

  if (job_result.kind === 'missing') {
    deps.logger.warn(
      { agent_id: agent.agent_id, job_id: job.job_id },
      'agent has no record of our job — orphaned',
    );
    deps.store.updateJobStatus(job.job_id, 'failed', {
      completed_at: Date.now(),
      outcome: 'orphaned',
      result_json: JSON.stringify({ error: 'job missing on agent restart' }),
    });
    deps.metrics?.recordJobCompletion(job.method, 'orphaned');
    return;
  }

  if (job_result.kind === 'in_flight') {
    // Race window between dispatch and our /status snapshot: the agent has
    // the job but hasn't reported it as current_job yet. Skip — the next
    // tick's /status will see it. Without this branch we'd mis-orphan a
    // healthy in-flight job.
    deps.logger.debug(
      { agent_id: agent.agent_id, job_id: job.job_id },
      'job in flight per agent /jobs/:id but missing from /status — will retry next tick',
    );
    return;
  }

  const result = job_result.result;
  const finalStatus = result.outcome === 'success' ? 'complete' : 'failed';
  deps.store.updateJobStatus(job.job_id, finalStatus, {
    completed_at: Date.now(),
    outcome: result.outcome,
    result_json: JSON.stringify(result),
  });
  deps.metrics?.recordJobCompletion(result.method, result.outcome);
  deps.logger.info(
    {
      agent_id: agent.agent_id,
      job_id: job.job_id,
      method: result.method,
      repo: result.repo,
      outcome: result.outcome,
      duration_ms: result.duration_ms,
    },
    'job completed',
  );

  // Persist session id only when the run produced something meaningful.
  if (result.session_id && (result.outcome === 'success' || result.outcome === 'task_error')) {
    try {
      deps.store.upsertSession(agent.agent_id, result.repo, result.session_id);
    } catch (err) {
      deps.logger.warn(
        { agent_id: agent.agent_id, repo: result.repo, err: String(err) },
        'failed to persist session_id',
      );
    }
  }
}
