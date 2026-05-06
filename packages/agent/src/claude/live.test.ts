import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { __test, LiveClaudeAdapter } from './live.js';
import { loadConfig, resolveMaxTurns } from '../config.js';
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
      timeoutMs: 0,
    });

    await adapter.run(baseOpts);

    expect(querySpy).toHaveBeenCalledOnce();
    const callArg = querySpy.mock.calls[0][0] as { options: Record<string, unknown> };
    expect(callArg.options.maxTurns).toBe(50);
  });

  it('passes the env-overridden value when CLAUDE_MAX_TURNS_MERGE is set', async () => {
    const cfg = loadConfig({ ...baseEnv(), CLAUDE_MAX_TURNS_MERGE: '20' });
    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: (m) => resolveMaxTurns(cfg, m),
      timeoutMs: 0,
    });

    await adapter.run(baseOpts);

    const callArg = querySpy.mock.calls[0][0] as { options: Record<string, unknown> };
    expect(callArg.options.maxTurns).toBe(20);
  });

  it('resolves a different budget for each method', async () => {
    const cfg = loadConfig(baseEnv());
    const adapter = new LiveClaudeAdapter({
      logger: silentLog,
      maxTurnsForMethod: (m) => resolveMaxTurns(cfg, m),
      timeoutMs: 0,
    });

    const methods: Method[] = ['plan', 'implement', 'review', 'address_review', 'merge'];
    const expected = [100, 250, 60, 200, 50];

    for (let i = 0; i < methods.length; i++) {
      querySpy.mockReset();
      querySpy.mockReturnValue({
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      });
      await adapter.run({ ...baseOpts, method: methods[i]! });
      const callArg = querySpy.mock.calls[0][0] as { options: Record<string, unknown> };
      expect(callArg.options.maxTurns).toBe(expected[i]);
    }
  });
});
