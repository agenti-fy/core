import { request } from 'undici';
import {
  RegisterRequestSchema,
  RegisterResponseSchema,
  type RegisterRequest,
  type Status,
} from '@agenti-fy/shared';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Thrown by coordinator client methods on non-200 responses. Carries the
 * statusCode so callers can branch (e.g. heartbeat 404 → re-register).
 */
export class CoordinatorHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'CoordinatorHttpError';
  }
}

export class CoordinatorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async register(req: RegisterRequest): Promise<string> {
    const body = RegisterRequestSchema.parse(req);
    const res = await request(`${this.baseUrl}/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
    if (res.statusCode !== 200) {
      const text = await res.body.text();
      throw new Error(`register failed: ${res.statusCode} ${text}`);
    }
    const json = (await res.body.json());
    return RegisterResponseSchema.parse(json).agent_id;
  }

  async heartbeat(agent_id: string, status: Status): Promise<void> {
    const res = await request(`${this.baseUrl}/agents/${agent_id}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
    await res.body.dump();
    if (res.statusCode !== 200) {
      throw new CoordinatorHttpError(res.statusCode, `heartbeat failed: ${res.statusCode}`);
    }
  }

  async putSession(agent_id: string, repo: string, session_id: string): Promise<void> {
    const res = await request(`${this.baseUrl}/sessions/${agent_id}/${repo}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id }),
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs,
    });
    await res.body.dump();
    if (res.statusCode !== 200) {
      throw new Error(`putSession failed: ${res.statusCode}`);
    }
  }
}
