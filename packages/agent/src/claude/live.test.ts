import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { __test, LiveClaudeAdapter } from './live.js';
import { loadConfig, resolveMaxTurns, applyHotReloadable } from '../config.js';
import type { Method } from '@agentify/shared';

const { extractArtifacts } = __test;
const silentLog = pino({ level: 'silent' });

describe('extractArtifacts', () => {
  it('parses bare JSON object as the slot contents', () => {
    const out = extractArtifacts('plan', '{"child_issues":[101,102,103]}', silentLog);
    expect(out).toEqual({ plan: { child_issues: [101, 102, 103] } });
  });

  it('extracts JSON from a fenced ```json block, last block wins', () => {
    const text = [
      "Here's a draft:",
      '```json',
      '{ "child_issues": [1] }',
      '```',
      'Actually, on second thought:',
      '```json',
      '{ "child_issues": [2, 3] }',
      '```',
    ].join('\n');
    const out = extractArtifacts('plan', text, silentLog);
    expect(out).toEqual({ plan: { child_issues: [2, 3] } });
  });

  it('extracts JSON from an unlabelled fenced code block', () => {
    const text = ['Done.', '```', '{ "merged": true, "closed_issue": 7 }', '```'].join('\n');
    const out = extractArtifacts('merge', text, silentLog);
    expect(out).toEqual({ merge: { merged: true, closed_issue: 7 } });
  });

  it('extracts the trailing balanced {...} when the JSON sits inside prose', () => {
    const text =
      'I created issues #11 and #12 as planned.\n\n' +
      'Output: { "child_issues": [11, 12] }';
    const out = extractArtifacts('plan', text, silentLog);
    expect(out).toEqual({ plan: { child_issues: [11, 12] } });
  });

  it('returns {} when the model produced unrelated prose', () => {
    const out = extractArtifacts('plan', 'Sorry, I could not complete this task.', silentLog);
    expect(out).toEqual({});
  });

  it('returns {} when the JSON does not match the schema (e.g. wrong types)', () => {
    const out = extractArtifacts('plan', '{ "child_issues": ["not-a-number"] }', silentLog);
    expect(out).toEqual({});
  });

  it('returns {} on completely empty final text', () => {
    expect(extractArtifacts('plan', '', silentLog)).toEqual({});
    expect(extractArtifacts('plan', '   \n\n  ', silentLog)).toEqual({});
  });

  it('parses each method slot correctly', () => {
    expect(
      extractArtifacts('implement', '{"branch":"feat/foo/1-bar","pr_number":42}', silentLog),
    ).toEqual({ implement: { branch: 'feat/foo/1-bar', pr_number: 42 } });

    expect(
      extractArtifacts('review', '{"review_id":99,"verdict":"approved"}', silentLog),
    ).toEqual({ review: { review_id: 99, verdict: 'approved' } });

    expect(
      extractArtifacts('address_review', '{"commits_pushed":2,"rerequested":true}', silentLog),
    ).toEqual({ address_review: { commits_pushed: 2, rerequested: true } });

    expect(
      extractArtifacts('merge', '{"merged":true}', silentLog),
    ).toEqual({ merge: { merged: true } });
  });

  it('tolerates extra unknown fields when validating', () => {
    // The schema strips unknowns by default; we accept the JSON and keep only
    // known fields.
    const out = extractArtifacts(
      'plan',
      '{ "child_issues": [1,2], "notes": "ignored" }',
      silentLog,
    );
    expect(out).toEqual({ plan: { child_issues: [1, 2] } });
  });
});

// ---------------------------------------------------------------------------
// LiveClaudeAdapter.buildSdkOptions — per-method tool scoping
// ---------------------------------------------------------------------------

describe('LiveClaudeAdapter.buildSdkOptions', () => {
  const baseOpts = {
    repo: 'org/repo',
    target_id: 1,
    personaBody: '',
    skillPrompt: 'do the thing',
    systemPrompt: 'do the thing',
    model: undefined,
    sessionId: null,
    cwd: '/tmp/wt',
  };

  const ctx = {
    maxTurns: 100,
    permissionMode: 'bypassPermissions',
    abortController: new AbortController(),
  };

  const METHODS = ['plan', 'implement', 'review', 'address_review', 'merge'] as const;
  const ALWAYS_DENIED = ['Task', 'WebFetch', 'WebSearch'];

  it('denies Task, WebFetch, WebSearch for every method', () => {
    for (const method of METHODS) {
      const opts = LiveClaudeAdapter.buildSdkOptions({ ...baseOpts, method }, ctx);
      const disallowed = opts['disallowedTools'] as string[];
      expect(disallowed, `method=${method}`).toEqual(expect.arrayContaining(ALWAYS_DENIED));
    }
  });

  it('plan and review additionally deny Write, Edit, NotebookEdit', () => {
    for (const method of ['plan', 'review'] as const) {
      const opts = LiveClaudeAdapter.buildSdkOptions({ ...baseOpts, method }, ctx);
      const disallowed = opts['disallowedTools'] as string[];
      expect(disallowed, `method=${method}`).toEqual(
        expect.arrayContaining(['Write', 'Edit', 'NotebookEdit']),
      );
    }
  });

  it('implement, address_review, merge do NOT deny Write / Edit / NotebookEdit', () => {
    for (const method of ['implement', 'address_review', 'merge'] as const) {
      const opts = LiveClaudeAdapter.buildSdkOptions({ ...baseOpts, method }, ctx);
      const disallowed = (opts['disallowedTools'] as string[]) ?? [];
      expect(disallowed, `method=${method}`).not.toContain('Write');
      expect(disallowed, `method=${method}`).not.toContain('Edit');
      expect(disallowed, `method=${method}`).not.toContain('NotebookEdit');
    }
  });

  it('plan and review carry a Bash allowlist covering gh and read-only git', () => {
    const EXPECTED = ['Bash(gh *)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git diff*)', 'Bash(git rev-parse*)'];
    for (const method of ['plan', 'review'] as const) {
      const opts = LiveClaudeAdapter.buildSdkOptions({ ...baseOpts, method }, ctx);
      const allowed = opts['allowedTools'] as string[];
      expect(allowed, `method=${method}`).toEqual(expect.arrayContaining(EXPECTED));
      expect(allowed, `bare Bash must not appear for method=${method}`).not.toContain('Bash');
    }
  });

  it('implement, address_review, merge have no Bash allowlist (full Bash available)', () => {
    for (const method of ['implement', 'address_review', 'merge'] as const) {
      const opts = LiveClaudeAdapter.buildSdkOptions({ ...baseOpts, method }, ctx);
      expect(opts['allowedTools'], `method=${method}`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveMaxTurns — per-method turn budget
// ---------------------------------------------------------------------------

function baseEnv(): NodeJS.ProcessEnv {
  return {
    COORDINATOR_URL: 'http://coordinator:8080',
    AGENT_PUBLIC_URL: 'http://agent:8080',
    DISABLE_GITHUB: 'true',
  };
}

describe('resolveMaxTurns', () => {
  it('returns per-method defaults when no env overrides are set', () => {
    const cfg = loadConfig(baseEnv());
    const defaults: Record<Method, number> = {
      plan: 100,
      implement: 250,
      review: 60,
      address_review: 200,
      merge: 50,
    };
    for (const [method, expected] of Object.entries(defaults) as [Method, number][]) {
      expect(resolveMaxTurns(cfg, method)).toBe(expected);
    }
  });

  it('CLAUDE_MAX_TURNS overrides all per-method defaults when no specific var is set', () => {
    const cfg = loadConfig({ ...baseEnv(), CLAUDE_MAX_TURNS: '99' });
    for (const method of ['plan', 'implement', 'review', 'address_review', 'merge'] as Method[]) {
      expect(resolveMaxTurns(cfg, method)).toBe(99);
    }
  });

  it('per-method var takes precedence over CLAUDE_MAX_TURNS', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      CLAUDE_MAX_TURNS: '99',
      CLAUDE_MAX_TURNS_MERGE: '25',
    });
    expect(resolveMaxTurns(cfg, 'merge')).toBe(25);
    // Other methods still use the global fallback.
    expect(resolveMaxTurns(cfg, 'plan')).toBe(99);
  });

  it('each per-method var is independently configurable', () => {
    const cfg = loadConfig({
      ...baseEnv(),
      CLAUDE_MAX_TURNS_PLAN: '77',
      CLAUDE_MAX_TURNS_IMPLEMENT: '300',
      CLAUDE_MAX_TURNS_REVIEW: '40',
      CLAUDE_MAX_TURNS_ADDRESS_REVIEW: '150',
      CLAUDE_MAX_TURNS_MERGE: '30',
    });
    expect(resolveMaxTurns(cfg, 'plan')).toBe(77);
    expect(resolveMaxTurns(cfg, 'implement')).toBe(300);
    expect(resolveMaxTurns(cfg, 'review')).toBe(40);
    expect(resolveMaxTurns(cfg, 'address_review')).toBe(150);
    expect(resolveMaxTurns(cfg, 'merge')).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// LiveClaudeAdapter — maxTurns wired to SDK options at run time
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const querySpy = vi.fn();
  return { query: querySpy };
});

describe('LiveClaudeAdapter maxTurns per method', () => {
  let querySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    querySpy = sdk.query as ReturnType<typeof vi.fn>;
    querySpy.mockReset();
    // Return an empty async iterable so the adapter's for-await loop completes.
    querySpy.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    });
  });

  const baseOpts = {
    method: 'merge' as Method,
    repo: 'acme/api',
    target_id: 7,
    personaBody: '',
    skillPrompt: 'merge it',
    systemPrompt: 'merge it',
    model: undefined,
    sessionId: null,
    cwd: '/tmp/wt',
  };

  it('passes maxTurns: 50 to query() for a merge job (default config)', async () => {
    const cfg = loadConfig(baseEnv());
    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: (m) => resolveMaxTurns(cfg, m),
      timeoutMsGetter: () => 0,
    });

    await adapter.run(baseOpts);

    expect(querySpy).toHaveBeenCalledOnce();
    const callArg = querySpy.mock.calls[0]![0]! as { options: Record<string, unknown> };
    expect(callArg.options.maxTurns).toBe(50);
  });

  it('passes the env-overridden value when CLAUDE_MAX_TURNS_MERGE is set', async () => {
    const cfg = loadConfig({ ...baseEnv(), CLAUDE_MAX_TURNS_MERGE: '20' });
    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: (m) => resolveMaxTurns(cfg, m),
      timeoutMsGetter: () => 0,
    });

    await adapter.run(baseOpts);

    const callArg = querySpy.mock.calls[0]![0]! as { options: Record<string, unknown> };
    expect(callArg.options.maxTurns).toBe(20);
  });

  it('resolves a different budget for each method', async () => {
    const cfg = loadConfig(baseEnv());
    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: (m) => resolveMaxTurns(cfg, m),
      timeoutMsGetter: () => 0,
    });

    const methods: Method[] = ['plan', 'implement', 'review', 'address_review', 'merge'];
    const expected = [100, 250, 60, 200, 50];

    for (let i = 0; i < methods.length; i++) {
      querySpy.mockReset();
      querySpy.mockReturnValue({
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      });
      await adapter.run({ ...baseOpts, method: methods[i]! });
      const callArg = querySpy.mock.calls[0]![0]! as { options: Record<string, unknown> };
      expect(callArg.options.maxTurns).toBe(expected[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// applyHotReloadable — in-place field mutation
// ---------------------------------------------------------------------------

describe('applyHotReloadable', () => {
  it('propagates all claudeMaxTurns* fields from fresh to config', () => {
    const cfg = loadConfig(baseEnv());
    const fresh = loadConfig({
      ...baseEnv(),
      CLAUDE_MAX_TURNS: '99',
      CLAUDE_MAX_TURNS_PLAN: '77',
      CLAUDE_MAX_TURNS_IMPLEMENT: '300',
      CLAUDE_MAX_TURNS_REVIEW: '40',
      CLAUDE_MAX_TURNS_ADDRESS_REVIEW: '150',
      CLAUDE_MAX_TURNS_MERGE: '25',
    });
    applyHotReloadable(cfg, fresh);
    expect(cfg.claudeMaxTurns).toBe(99);
    expect(cfg.claudeMaxTurnsPlan).toBe(77);
    expect(cfg.claudeMaxTurnsImplement).toBe(300);
    expect(cfg.claudeMaxTurnsReview).toBe(40);
    expect(cfg.claudeMaxTurnsAddressReview).toBe(150);
    expect(cfg.claudeMaxTurnsMerge).toBe(25);
  });

  it('propagates claudeTimeoutMs from fresh to config', () => {
    const cfg = loadConfig(baseEnv());
    const fresh = loadConfig({ ...baseEnv(), CLAUDE_TIMEOUT_MS: '60000' });
    applyHotReloadable(cfg, fresh);
    expect(cfg.claudeTimeoutMs).toBe(60_000);
  });

  it('does NOT mutate static-at-boot fields (host, port, coordinatorUrl)', () => {
    const cfg = loadConfig(baseEnv());
    const originalHost = cfg.host;
    const originalPort = cfg.port;
    const originalCoordinatorUrl = cfg.coordinatorUrl;
    // fresh has different values for those fields, but applyHotReloadable must ignore them.
    const fresh = loadConfig({
      ...baseEnv(),
      COORDINATOR_URL: 'http://other-coordinator:9999',
      CLAUDE_MAX_TURNS_MERGE: '10',
      CLAUDE_TIMEOUT_MS: '30000',
    });
    applyHotReloadable(cfg, fresh);
    expect(cfg.host).toBe(originalHost);
    expect(cfg.port).toBe(originalPort);
    expect(cfg.coordinatorUrl).toBe(originalCoordinatorUrl);
    // Turn budget and timeout were updated.
    expect(cfg.claudeMaxTurnsMerge).toBe(10);
    expect(cfg.claudeTimeoutMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// LiveClaudeAdapter hot-reload — config mutation after construction
// ---------------------------------------------------------------------------

describe('LiveClaudeAdapter hot-reload', () => {
  let querySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    querySpy = sdk.query as ReturnType<typeof vi.fn>;
    querySpy.mockReset();
    querySpy.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    });
  });

  const baseOpts = {
    method: 'merge' as Method,
    repo: 'acme/api',
    target_id: 7,
    personaBody: '',
    skillPrompt: 'merge it',
    systemPrompt: 'merge it',
    model: undefined,
    sessionId: null,
    cwd: '/tmp/wt',
  };

  it('picks up a mutated config.claudeMaxTurnsMerge on the next run()', async () => {
    const cfg = loadConfig(baseEnv());
    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: (m) => resolveMaxTurns(cfg, m),
      timeoutMsGetter: () => 0,
    });

    // First run uses the original default (50).
    await adapter.run(baseOpts);
    expect(
      (querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }).options.maxTurns,
    ).toBe(50);

    // Simulate applyHotReloadable() mutating the config.
    cfg.claudeMaxTurnsMerge = 15;
    querySpy.mockReset();
    querySpy.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    });

    // Second run should use the new value without rebuilding the adapter.
    await adapter.run(baseOpts);
    expect(
      (querySpy.mock.calls[0]![0] as { options: Record<string, unknown> }).options.maxTurns,
    ).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// LiveClaudeAdapter hot-reload (timeoutMs) — getter called at run() time
// ---------------------------------------------------------------------------

describe('LiveClaudeAdapter hot-reload (timeoutMs)', () => {
  let querySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    querySpy = sdk.query as ReturnType<typeof vi.fn>;
    querySpy.mockReset();
    querySpy.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    });
  });

  const baseOpts = {
    method: 'merge' as Method,
    repo: 'acme/api',
    target_id: 7,
    personaBody: '',
    skillPrompt: 'merge it',
    systemPrompt: 'merge it',
    model: undefined,
    sessionId: null,
    cwd: '/tmp/wt',
  };

  it('picks up a mutated config.claudeTimeoutMs on the next run()', async () => {
    const cfg = loadConfig(baseEnv());
    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: (m) => resolveMaxTurns(cfg, m),
      timeoutMsGetter: () => cfg.claudeTimeoutMs,
    });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    // First run: default claudeTimeoutMs (15 * 60 * 1000 = 900_000).
    await adapter.run(baseOpts);
    const firstCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms !== 30_000);
    expect(firstCalls[0]?.[1]).toBe(15 * 60 * 1000);

    // Simulate applyHotReloadable() writing a new claudeTimeoutMs.
    cfg.claudeTimeoutMs = 60_000;
    setTimeoutSpy.mockClear();
    querySpy.mockReset();
    querySpy.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    });

    // Second run should schedule the abort timer with the new value without
    // rebuilding the adapter.
    await adapter.run(baseOpts);
    const secondCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms !== 30_000);
    expect(secondCalls[0]?.[1]).toBe(60_000);

    setTimeoutSpy.mockRestore();
  });
});
