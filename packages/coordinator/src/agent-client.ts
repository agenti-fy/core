import { request } from 'undici';
import {
  AgentStatusResponseSchema,
  DispatchAcceptedSchema,
  JobResultSchema,
  METHOD_PATHS,
  type AgentStatusResponse,
  type DispatchAccepted,
  type DispatchRequest,
  type JobResult,
  type Method,
} from '@agenti-fy/shared';

export type DispatchOutcome =
  | { kind: 'accepted'; data: DispatchAccepted }
  | { kind: 'busy'; current_job_id: string | null }
  | { kind: 'failure' }
  | { kind: 'method_not_supported' }
  /** Non-handled 4xx (e.g. 400 validation rejected). Definitive — the agent
   *  saw the request and refused. Treat as failed_to_dispatch. */
  | { kind: 'rejected'; statusCode: number; message: string }
  /** Network failure or unknown 5xx. Ambiguous — the agent may or may not
   *  have started running. The job is left dispatched for the status poll
   *  to reconcile via /status + /jobs/:id. */
  | { kind: 'transport_error'; message: string };

/**
 * Tri-state result for `getJob`. Distinguishing "in-flight" from "missing" is
 * critical: a previous version collapsed both into `null`, causing the
 * job-completion-poller to mark in-flight jobs as orphaned during the race
 * where dispatch lands between `/status` snapshot and `listRunningJobsForAgent`.
 */
export type GetJobResult =
  /** Agent returned 404 — it has no record of this job. Orphan. */
  | { kind: 'missing' }
  /** Agent has the JobRecord but it hasn't completed yet. Skip reconcile;
   *  the next poll tick's /status will see current_job and resolve. */
  | { kind: 'in_flight' }
  /** Agent has finished the job. Apply the result terminally. */
  | { kind: 'done'; result: JobResult };

const HTTP_TIMEOUT_MS = 10_000;

export class AgentRpcClient {
  /** POST /<method> to an agent. Returns a structured outcome (no throw on 4xx/5xx). */
  async dispatch(
    agentUrl: string,
    method: Method,
    body: DispatchRequest,
  ): Promise<DispatchOutcome> {
    const url = `${agentUrl}/${METHOD_PATHS[method]}`;
    try {
      const res = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        bodyTimeout: HTTP_TIMEOUT_MS,
        headersTimeout: HTTP_TIMEOUT_MS,
      });
      if (res.statusCode === 202) {
        const json = (await res.body.json());
        return { kind: 'accepted', data: DispatchAcceptedSchema.parse(json) };
      }
      if (res.statusCode === 409) {
        const json = (await res.body.json().catch(() => null)) as
          | { current_job_id?: string | null }
          | null;
        return { kind: 'busy', current_job_id: json?.current_job_id ?? null };
      }
      if (res.statusCode === 503) {
        // The agent uses 503 for three distinct conditions:
        //   - FAILURE: the agent self-reported FAILURE (real, sticky)
        //   - NOT_REGISTERED: agent is mid-boot, hasn't finished register()
        //   - SHUTTING_DOWN: agent's drain flag is set
        // Only FAILURE should mark the agent unavailable in the store; the
        // other two are transient conditions that resolve on their own.
        const json = (await res.body.json().catch(() => null)) as
          | { error?: string }
          | null;
        if (json?.error === 'SHUTTING_DOWN' || json?.error === 'NOT_REGISTERED') {
          return {
            kind: 'transport_error',
            message: `agent ${json.error}`,
          };
        }
        return { kind: 'failure' };
      }
      if (res.statusCode === 405) {
        await res.body.dump();
        return { kind: 'method_not_supported' };
      }
      const text = await res.body.text();
      // 4xx that isn't 405/409: the agent saw the request and refused (e.g.
      // 400 validation). Definitive rejection — distinct from transport error.
      if (res.statusCode >= 400 && res.statusCode < 500) {
        return {
          kind: 'rejected',
          statusCode: res.statusCode,
          message: `${res.statusCode}: ${text}`,
        };
      }
      // 5xx and unknown: ambiguous, treat as transport.
      return { kind: 'transport_error', message: `unexpected ${res.statusCode}: ${text}` };
    } catch (err) {
      return {
        kind: 'transport_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getStatus(agentUrl: string): Promise<AgentStatusResponse> {
    const res = await request(`${agentUrl}/status`, {
      method: 'GET',
      headersTimeout: HTTP_TIMEOUT_MS,
      bodyTimeout: HTTP_TIMEOUT_MS,
    });
    if (res.statusCode !== 200) {
      const text = await res.body.text();
      throw new Error(`agent /status returned ${res.statusCode}: ${text}`);
    }
    const json = (await res.body.json());
    return AgentStatusResponseSchema.parse(json);
  }

  async getJob(agentUrl: string, job_id: string): Promise<GetJobResult> {
    const res = await request(`${agentUrl}/jobs/${job_id}`, {
      method: 'GET',
      headersTimeout: HTTP_TIMEOUT_MS,
      bodyTimeout: HTTP_TIMEOUT_MS,
    });
    if (res.statusCode === 404) {
      await res.body.dump();
      return { kind: 'missing' };
    }
    if (res.statusCode !== 200) {
      const text = await res.body.text();
      throw new Error(`agent /jobs/${job_id} returned ${res.statusCode}: ${text}`);
    }
    const json = (await res.body.json()) as {
      result?: unknown;
      completed_at?: number | null;
    };
    // The agent's /jobs/:id route returns the full JobRecord. completed_at
    // is null while the job is still running. Without distinguishing this
    // from "result is unset because the job is missing", a poll that lands
    // between dispatch and completion would mis-orphan a healthy in-flight
    // job (job-poller race).
    if (json.completed_at == null || json.result == null) {
      return { kind: 'in_flight' };
    }
    return { kind: 'done', result: JobResultSchema.parse(json.result) };
  }

  /**
   * POST /reset to an agent. Returns a structured result instead of throwing
   * on transport failures (DNS, connection refused, timeout) — without this,
   * a stopped/removed agent container surfaces in the TUI as a generic 500
   * with `getaddrinfo ENOTFOUND <hostname>` and the operator has no clear
   * action to take. `statusCode: 0` signals "never reached the agent"; the
   * route handler maps it to a 503 with a clear "agent unreachable" message.
   */
  async reset(agentUrl: string): Promise<{ ok: boolean; statusCode: number; body: unknown }> {
    try {
      const res = await request(`${agentUrl}/reset`, {
        method: 'POST',
        headersTimeout: HTTP_TIMEOUT_MS,
        bodyTimeout: HTTP_TIMEOUT_MS,
      });
      const body = (await res.body.json().catch(() => null));
      return { ok: res.statusCode === 200, statusCode: res.statusCode, body };
    } catch (err) {
      return {
        ok: false,
        statusCode: 0,
        body: {
          error: 'unreachable',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
