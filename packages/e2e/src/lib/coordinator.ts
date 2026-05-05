import { request } from 'undici';
import {
  AgentRecordSchema,
  JobRecordSchema,
  RepoRecordSchema,
  type AgentRecord,
  type JobRecord,
  type RepoRecord,
} from '@agentify/shared';
import { z } from 'zod';

const HaltSchema = z.object({ halted: z.boolean() });

function normalizeBaseUrl(s: string): string {
  return s.replace(/\/+$/, '');
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Minimal HTTP client over the coordinator's API. */
export class CoordinatorClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async health(): Promise<{ ok: true; service: string; version: string; uptime_s: number }> {
    return this.get(
      '/health',
      z.object({
        ok: z.literal(true),
        service: z.string(),
        version: z.string(),
        uptime_s: z.number().int().nonnegative(),
      }),
    );
  }

  listAgents(): Promise<AgentRecord[]> {
    return this.get('/agents', z.array(AgentRecordSchema));
  }

  listJobs(): Promise<JobRecord[]> {
    return this.get('/jobs', z.array(JobRecordSchema));
  }

  listRepos(): Promise<RepoRecord[]> {
    return this.get('/repos', z.array(RepoRecordSchema));
  }

  async halted(): Promise<boolean> {
    return (await this.get('/control/halt', HaltSchema)).halted;
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
}
