import type { Logger } from 'pino';
import type { JobRecord } from '@agentify/shared';
import type { CoordinatorStore } from '../store.js';
import type { AgentRpcClient, GetJobResult } from '../agent-client.js';
import type { CoordinatorMetrics } from '../metrics.js';
import type { Config } from '../config.js';

export interface JobPollerDeps {
  store: CoordinatorStore;
  agentClient: AgentRpcClient;
  logger: Logger;
  metrics?: CoordinatorMetrics;
  config: Pick<Config, 'maxResultJsonBytes'>;
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

  // NOTE: kb_writes[*].bytes is agent-reported and purely informational metadata.
  // It is never consulted for any quota or control-flow decision here — the
  // enforcement gate is the serialized-payload size check immediately below.
  const serialized = JSON.stringify(result);
  // .length returns UTF-16 code units (not UTF-8 bytes); see maxResultJsonBytes JSDoc.
  const serializedBytes = serialized.length;
  if (serializedBytes > deps.config.maxResultJsonBytes) {
    deps.logger.warn(
      {
        agent_id: agent.agent_id,
        job_id: job.job_id,
        serialized_bytes: serializedBytes,
        cap: deps.config.maxResultJsonBytes,
      },
      'result_json exceeds MAX_RESULT_JSON_BYTES — artifacts dropped, outcome overridden to task_error',
    );
    const capMsg = `result_json exceeded MAX_RESULT_JSON_BYTES (${serializedBytes} > ${deps.config.maxResultJsonBytes}); artifacts dropped`;
    result.artifacts = {};
    result.outcome = 'task_error';
    result.error = result.error
      ? { ...result.error, message: `${result.error.message}; ${capMsg}` }
      : { message: capMsg };
    deps.metrics?.recordJobCompletion(result.method, 'task_error');
  } else {
    deps.metrics?.recordJobCompletion(result.method, result.outcome);
  }

  const finalStatus = result.outcome === 'success' ? 'complete' : 'failed';
  deps.store.updateJobStatus(job.job_id, finalStatus, {
    completed_at: Date.now(),
    outcome: result.outcome,
    result_json: JSON.stringify(result),
  });
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

  // Record plan→children mapping so the auto-close loop can track completion.
  if (
    result.method === 'plan' &&
    result.outcome === 'success' &&
    (result.artifacts.plan?.child_issues?.length ?? 0) > 0
  ) {
    try {
      const child_issues = result.artifacts.plan!.child_issues;
      deps.store.upsertPlan(result.repo, result.target_id, child_issues);
      deps.logger.info(
        { repo: result.repo, parent_id: result.target_id, child_count: child_issues.length },
        'plan recorded for auto-close tracking',
      );
    } catch (err) {
      deps.logger.warn(
        { repo: result.repo, parent_id: result.target_id, err: String(err) },
        'failed to record plan — auto-close will retry on next plan run',
      );
    }
  }
}
