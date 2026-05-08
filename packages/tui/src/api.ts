import { request } from 'undici';
import {
  AgentRecordSchema,
  JobRecordSchema,
  RepoRecordSchema,
  type AgentRecord,
  type JobRecord,
  type RepoRecord,
} from '@agenti-fy/shared';
import { z } from 'zod';

const HaltSchema = z.object({ halted: z.boolean() });

const DEFAULT_TIMEOUT_MS = 8000;

function normalizeBaseUrl(s: string): string {
  return s.replace(/\/+$/, '');
}

export class CoordinatorApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async listAgents(): Promise<AgentRecord[]> {
    return this.get('/agents', z.array(AgentRecordSchema));
  }

  async listJobs(opts?: { status?: 'open' | 'recent' | 'all'; limit?: number }): Promise<JobRecord[]> {
    const qs = new URLSearchParams();
    if (opts?.status) qs.set('status', opts.status);
    if (opts?.limit) qs.set('limit', String(opts.limit));
    const path = qs.toString() ? `/jobs?${qs.toString()}` : '/jobs';
    return this.get(path, z.array(JobRecordSchema));
  }

  async listRepos(): Promise<RepoRecord[]> {
    return this.get('/repos', z.array(RepoRecordSchema));
  }

  async getHalt(): Promise<boolean> {
    const r = await this.get('/control/halt', HaltSchema);
    return r.halted;
  }

  async setHalt(halted: boolean): Promise<void> {
    await this.post(halted ? '/halt' : '/resume');
  }

  async resetAgent(agent_id: string): Promise<void> {
    const res = await request(`${this.baseUrl}/agents/${agent_id}/reset`, {
      method: 'POST',
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
    if (res.statusCode === 200) {
      await res.body.dump();
      return;
    }
    // Surface BUSY (409) distinctly: the operator wants to know the agent is
    // mid-job, not just see "POST → 409".
    if (res.statusCode === 409) {
      const json = (await res.body.json().catch(() => null)) as
        | { body?: { current_job_id?: string | null } }
        | null;
      const job = json?.body?.current_job_id ?? '?';
      throw new Error(`agent is BUSY (job: ${job})`);
    }
    // 503 with agent_status_code: 0 means transport failure (DNS / connection
    // refused / timeout). The container is registered but unreachable — the
    // actionable advice is "restart the container", not "retry /reset".
    if (res.statusCode === 503) {
      const json = (await res.body.json().catch(() => null)) as
        | { agent_status_code?: number; body?: { message?: string } }
        | null;
      if (json?.agent_status_code === 0) {
        const detail = json.body?.message ? ` — ${json.body.message}` : '';
        throw new Error(`agent unreachable; restart its container${detail}`);
      }
    }
    const text = await res.body.text();
    throw new Error(`reset → ${res.statusCode}: ${text}`);
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const res = await request(`${this.baseUrl}${path}`, {
      method: 'GET',
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
    if (res.statusCode !== 200) {
      const text = await res.body.text();
      throw new Error(`GET ${path} → ${res.statusCode}: ${text}`);
    }
    const json = (await res.body.json());
    return schema.parse(json);
  }

  private async post(path: string): Promise<void> {
    const res = await request(`${this.baseUrl}${path}`, {
      method: 'POST',
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
    await res.body.dump();
    if (res.statusCode >= 400) {
      throw new Error(`POST ${path} → ${res.statusCode}`);
    }
  }
}
