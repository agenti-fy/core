import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk';
import type { SkillRunOptions } from './adapter.js';
import { __test, LiveClaudeAdapter } from './live.js';
import { loadConfig, resolveMaxTurns, applyHotReloadable } from '../config.js';
import type { Method } from '@agentify/shared';

// ---- vi.mock must be top-level so vitest hoists it ----
// Use vi.importActual inside the factory so SYSTEM_PROMPT_DYNAMIC_BOUNDARY
// tracks the real SDK export — a rename or re-spell will surface here first.
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<typeof ClaudeSdk>('@anthropic-ai/claude-agent-sdk');
  return {
    query: vi.fn(),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY: actual.SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  };
});

// Import the mocked bindings AFTER vi.mock so we get the mock reference.
// ESM live-binding: `query` in live.ts will see this same mock.
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';

const { extractArtifacts } = __test;
const silentLog = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Guard: SYSTEM_PROMPT_DYNAMIC_BOUNDARY tracks the SDK export, not a literal
// ---------------------------------------------------------------------------

it('SYSTEM_PROMPT_DYNAMIC_BOUNDARY matches the known string so an SDK rename fails loudly', () => {
  expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
});

// ---------------------------------------------------------------------------
// extractArtifacts unit tests (unchanged)
// ---------------------------------------------------------------------------

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

// LiveClaudeAdapter.buildSdkOptions — per-method tool scoping
// ---------------------------------------------------------------------------

describe('LiveClaudeAdapter.buildSdkOptions', () => {
  const baseOpts = {
    repo: 'org/repo',
    target_id: 1,
    personaBody: '',
    skillPrompt: 'do the thing',
    systemPrompt: { stable: 'do the thing', volatile: '' },
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
// LiveClaudeAdapter.buildSdkOptions — prompt caching via string[] systemPrompt
// ---------------------------------------------------------------------------

describe('LiveClaudeAdapter.buildSdkOptions — prompt caching', () => {
  const ctx = {
    maxTurns: 100,
    permissionMode: 'bypassPermissions',
    abortController: new AbortController(),
  };

  it('passes systemPrompt as a string[] with the boundary between stable and volatile', () => {
    const opts = LiveClaudeAdapter.buildSdkOptions(
      {
        method: 'implement',
        repo: 'org/repo',
        target_id: 99,
        personaBody: 'You are the implementer.',
        skillPrompt: 'do stuff\n\n## Task vars\nRepo: org/repo\nTarget: 99',
        systemPrompt: {
          stable: 'You are the implementer.\n\n---\n\ndo stuff',
          volatile: '## Task vars\nRepo: org/repo\nTarget: 99',
        },
        model: undefined,
        sessionId: null,
        cwd: '/tmp/wt',
      },
      ctx,
    );

    const sp = opts['systemPrompt'] as string[];
    expect(Array.isArray(sp)).toBe(true);
    const boundaryIdx = sp.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(boundaryIdx, 'boundary must be present').toBeGreaterThan(-1);
    expect(sp[0]).toContain('You are the implementer.');
    expect(sp[0]).toContain('do stuff');
    expect(sp[boundaryIdx + 1]).toContain('## Task vars');
  });

  it('places the stable prefix before the boundary (cacheable region)', () => {
    const stable = 'stable persona and skill template';
    const volatile = '## Task vars\nRepo: r\nTarget: 1';
    const opts = LiveClaudeAdapter.buildSdkOptions(
      {
        method: 'plan',
        repo: 'r',
        target_id: 1,
        personaBody: 'You are the planner.',
        skillPrompt: `${stable}\n\n${volatile}`,
        systemPrompt: { stable, volatile },
        model: undefined,
        sessionId: null,
        cwd: '/tmp/wt',
      },
      ctx,
    );

    const sp = opts['systemPrompt'] as string[];
    const boundaryIdx = sp.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    // Everything before the boundary should contain the stable content.
    const beforeBoundary = sp.slice(0, boundaryIdx).join('\n');
    expect(beforeBoundary).toContain(stable);
    // Everything after the boundary should contain the volatile content.
    const afterBoundary = sp.slice(boundaryIdx + 1).join('\n');
    expect(afterBoundary).toContain(volatile);
  });

  it('omits the boundary when volatile is empty (no dynamic trailer)', () => {
    const opts = LiveClaudeAdapter.buildSdkOptions(
      {
        method: 'merge',
        repo: 'org/repo',
        target_id: 1,
        personaBody: 'You are the merger.',
        skillPrompt: 'merge instructions',
        systemPrompt: { stable: 'merge instructions', volatile: '' },
        model: undefined,
        sessionId: null,
        cwd: '/tmp/wt',
      },
      ctx,
    );

    const sp = opts['systemPrompt'] as string[];
    expect(Array.isArray(sp)).toBe(true);
    expect(sp).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });

  it('stable section is byte-identical for different (repo, target_id) — cache key is stable', () => {
    const stableContent = 'fixed persona and skill template content';
    const makeOpts = (repo: string, target_id: number): SkillRunOptions => ({
      method: 'review',
      repo,
      target_id,
      personaBody: 'You are the reviewer.',
      skillPrompt: `${stableContent}\n\n## Task vars\nRepo: ${repo}\nTarget: ${target_id}`,
      systemPrompt: {
        stable: stableContent,
        volatile: `## Task vars\nRepo: ${repo}\nTarget: ${target_id}`,
      },
      model: undefined,
      sessionId: null,
      cwd: '/tmp/wt',
    });

    const optsA = LiveClaudeAdapter.buildSdkOptions(makeOpts('org/repo-a', 1), ctx);
    const optsB = LiveClaudeAdapter.buildSdkOptions(makeOpts('org/repo-b', 99), ctx);

    const spA = optsA['systemPrompt'] as string[];
    const spB = optsB['systemPrompt'] as string[];
    const boundaryIdxA = spA.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    const boundaryIdxB = spB.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    // The stable section (before the boundary) must be identical regardless of job vars.
    expect(spA.slice(0, boundaryIdxA)).toEqual(spB.slice(0, boundaryIdxB));
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

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<typeof ClaudeSdk>('@anthropic-ai/claude-agent-sdk');
  const querySpy = vi.fn();
  return { query: querySpy, SYSTEM_PROMPT_DYNAMIC_BOUNDARY: actual.SYSTEM_PROMPT_DYNAMIC_BOUNDARY };
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
    systemPrompt: { stable: 'merge it', volatile: '' },
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
      costLimitUsd: 0,
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
      costLimitUsd: 0,
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
      costLimitUsd: 0,
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
// loadConfig CLAUDE_TIMEOUT_MS — empty-string normalisation
// ---------------------------------------------------------------------------

describe('loadConfig CLAUDE_TIMEOUT_MS', () => {
  it('uses the schema default (900_000) when CLAUDE_TIMEOUT_MS is unset', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.claudeTimeoutMs).toBe(15 * 60 * 1000);
  });

  it('uses the schema default (900_000) when CLAUDE_TIMEOUT_MS is ""', () => {
    const cfg = loadConfig({ ...baseEnv(), CLAUDE_TIMEOUT_MS: '' });
    expect(cfg.claudeTimeoutMs).toBe(15 * 60 * 1000);
  });

  it('parses "0" as 0 (timeouts-disabled path preserved)', () => {
    const cfg = loadConfig({ ...baseEnv(), CLAUDE_TIMEOUT_MS: '0' });
    expect(cfg.claudeTimeoutMs).toBe(0);
  });

  it('parses a valid numeric string as the corresponding number', () => {
    const cfg = loadConfig({ ...baseEnv(), CLAUDE_TIMEOUT_MS: '60000' });
    expect(cfg.claudeTimeoutMs).toBe(60_000);
  });

  it('throws a ZodError when CLAUDE_TIMEOUT_MS is a non-numeric string', () => {
    expect(() => loadConfig({ ...baseEnv(), CLAUDE_TIMEOUT_MS: 'abc' })).toThrow();
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
    systemPrompt: { stable: 'merge it', volatile: '' },
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
      costLimitUsd: 0,
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
    systemPrompt: { stable: 'merge it', volatile: '' },
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
      costLimitUsd: 0,
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

// ---------------------------------------------------------------------------
// Cost limit enforcement
// ---------------------------------------------------------------------------

const costLimitBaseOpts: SkillRunOptions = {
  method: 'implement',
  repo: 'org/repo',
  target_id: 42,
  personaBody: '',
  skillPrompt: 'do stuff',
  systemPrompt: { stable: 'do stuff', volatile: '' },
  model: undefined,
  sessionId: null,
  cwd: '/tmp',
};

/**
 * Returns a mock `query` implementation that yields `messages` in order.
 * It reads `abortController` from the SDK options and throws on the next
 * yield after `ac.abort()` is called — matching real SDK abort behaviour.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAbortAwareQuery(messages: unknown[]): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (args: any) => {
    const ac: AbortController | undefined = args?.options?.abortController;
    return {
      [Symbol.asyncIterator]() {
        return (async function* () {
          for (const m of messages) {
            if (ac?.signal.aborted) {
              throw new Error('AbortError: The operation was aborted.');
            }
            yield m;
          }
        })();
      },
    };
  };
}

describe('LiveClaudeAdapter cost limit', () => {
  const mockQuery = vi.mocked(query);

  beforeEach(() => {
    __test.resetNoCostWarn();
  });

  it('aborts and returns task_error when cumulative cost exceeds limit', async () => {
    mockQuery.mockImplementation(
      makeAbortAwareQuery([
        { type: 'system', subtype: 'init', session_id: 'sess_cost_1' },
        { type: 'result', total_cost_usd: 2.5 },
        { type: 'result', total_cost_usd: 6.0 },  // triggers abort
        { type: 'result', total_cost_usd: 8.0 },  // never yielded
      ]),
    );

    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: () => 100,
      timeoutMsGetter: () => 0,
      costLimitUsd: 5.0,
    });
    const result = await adapter.run(costLimitBaseOpts);

    expect(result.outcome).toBe('task_error');
    expect(result.error?.message).toMatch(/cost limit exceeded/i);
    expect(result.error?.message).toContain('6.0000');
    expect(result.costUsd).toBe(6.0);
    // Must not include a stack (it's our own message, not an exception)
    expect(result.error).not.toHaveProperty('stack');
  });

  it('does not abort when cumulative cost stays below the limit', async () => {
    mockQuery.mockImplementation(
      makeAbortAwareQuery([
        { type: 'system', subtype: 'init', session_id: 'sess_cost_2' },
        { type: 'result', total_cost_usd: 1.0 },
        { type: 'result', total_cost_usd: 4.9 },
      ]),
    );

    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: () => 100,
      timeoutMsGetter: () => 0,
      costLimitUsd: 5.0,
    });
    const result = await adapter.run(costLimitBaseOpts);

    expect(result.outcome).toBe('success');
    expect(result.costUsd).toBe(4.9);
  });

  it('does not abort when costLimitUsd is 0 (ceiling disabled)', async () => {
    mockQuery.mockImplementation(
      makeAbortAwareQuery([
        { type: 'system', subtype: 'init', session_id: 'sess_cost_3' },
        { type: 'result', total_cost_usd: 999.0 },
      ]),
    );

    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: () => 100,
      timeoutMsGetter: () => 0,
      costLimitUsd: 0,
    });
    const result = await adapter.run(costLimitBaseOpts);

    expect(result.outcome).toBe('success');
    expect(result.costUsd).toBe(999.0);
  });

  it('skips ceiling check when SDK messages carry no cost data (best-effort)', async () => {
    mockQuery.mockImplementation(
      makeAbortAwareQuery([
        { type: 'system', subtype: 'init', session_id: 'sess_cost_4' },
        { type: 'result' }, // no total_cost_usd
      ]),
    );

    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: () => 100,
      timeoutMsGetter: () => 0,
      costLimitUsd: 5.0,
    });
    // Should complete without aborting — ceiling check is skipped
    const result = await adapter.run(costLimitBaseOpts);
    expect(result.outcome).toBe('success');
    expect(result.costUsd).toBeUndefined();
  });
});
