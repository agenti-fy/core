/**
 * anthropic.test.ts — unit tests for the Anthropic auth + tunables driver.
 *
 * All I/O is injectable via PassThrough streams — no real TTY required.
 * Lines are fed one per tick (chained setImmediate) so that each
 * readline.Interface or data-event listener is already attached when its
 * line arrives, matching the pattern established in preamble.test.ts and
 * documented in KB-Tinkerer.md.
 */

import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { BUILTIN_PERSONAS } from '@agenti-fy/shared';
import { runAnthropic } from './anthropic.js';
import { PromptCancelled } from '../prompts.js';
import type { IoStreams } from '../prompts.js';
import type { WizardState } from '../state.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an IoStreams pair fed by the given lines, one per tick.
 *
 * Lines are written with chained setImmediate so each readline.Interface
 * (created inside ask/askChoice) and each 'data' listener (used by askMasked)
 * is already attached when its line arrives.  Writing all lines at once lets
 * readline drain the buffer before subsequent listeners are created.
 */
function makeIo(lines: string[]): IoStreams & { output: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const remaining = [...lines];
  function writeNext(): void {
    const line = remaining.shift();
    if (line !== undefined) {
      stdin.write(`${line}\n`);
      setImmediate(writeNext);
    } else {
      stdin.end();
    }
  }
  setImmediate(writeNext);

  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  return {
    stdin,
    stdout,
    output: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Build a minimal WizardState for the anthropic phase. */
function makeState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    version: 2,
    prefix: 'test-prefix',
    repo: { owner: 'alice', name: 'sandbox' },
    ownerType: 'personal',
    coordinator: undefined,
    personas: Object.fromEntries(
      BUILTIN_PERSONAS.map((p) => [p, undefined]),
    ),
    anthropic: undefined,
    tunables: undefined,
    ...overrides,
  };
}

// ── Happy path — ANTHROPIC_API_KEY ────────────────────────────────────────────

describe('runAnthropic — ANTHROPIC_API_KEY happy path', () => {
  it('returns anthropic with kind=api_key and the provided key', async () => {
    // '1' = api_key choice (first option), 'sk-ant-testkey' = secret,
    // '1' = info, '30' = WORK_POLL_S, '5.0' = CLAUDE_COST_LIMIT_USD
    const io = makeIo(['1', 'sk-ant-testkey', '1', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.anthropic).toEqual({ kind: 'api_key', value: 'sk-ant-testkey' });
  });

  it('returns tunables with LOG_LEVEL=info, WORK_POLL_S=30, CLAUDE_COST_LIMIT_USD=5', async () => {
    const io = makeIo(['1', 'sk-ant-testkey', '1', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables).toMatchObject({
      LOG_LEVEL: 'info',
      WORK_POLL_S: 30,
      CLAUDE_COST_LIMIT_USD: 5.0,
    });
  });

  it('converts WORK_POLL_S to a number in the returned tunables', async () => {
    const io = makeIo(['1', 'sk-ant-testkey', '1', '60', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(typeof result.tunables?.['WORK_POLL_S']).toBe('number');
    expect(result.tunables?.['WORK_POLL_S']).toBe(60);
  });

  it('converts CLAUDE_COST_LIMIT_USD to a number in the returned tunables', async () => {
    const io = makeIo(['1', 'sk-ant-testkey', '1', '30', '12.5']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(typeof result.tunables?.['CLAUDE_COST_LIMIT_USD']).toBe('number');
    expect(result.tunables?.['CLAUDE_COST_LIMIT_USD']).toBe(12.5);
  });
});

// ── Happy path — CLAUDE_CODE_OAUTH_TOKEN ──────────────────────────────────────

describe('runAnthropic — CLAUDE_CODE_OAUTH_TOKEN happy path', () => {
  it('returns anthropic with kind=oauth_token', async () => {
    // '2' = oauth_token choice; token must be ≥ 20 chars
    const io = makeIo(['2', 'a-valid-oauth-token-123456', '1', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.anthropic).toEqual({
      kind: 'oauth_token',
      value: 'a-valid-oauth-token-123456',
    });
  });

  it('accepts different LOG_LEVEL choices', async () => {
    // '2' = debug
    const io = makeIo(['2', 'a-valid-oauth-token-123456', '2', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['LOG_LEVEL']).toBe('debug');
  });
});

// ── ANTHROPIC_API_KEY validation ──────────────────────────────────────────────

describe('runAnthropic — ANTHROPIC_API_KEY validation', () => {
  it('re-prompts when key does not start with sk-ant-', async () => {
    // First key: invalid; second key: valid
    const io = makeIo(['1', 'badkey-not-valid', 'sk-ant-goodkey', '1', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.anthropic).toEqual({ kind: 'api_key', value: 'sk-ant-goodkey' });
    expect(io.output()).toContain('sk-ant-');
  });

  it('re-prompts multiple times until a valid key is given', async () => {
    const io = makeIo(['1', 'bad1', 'bad2', 'sk-ant-final', '1', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.anthropic).toEqual({ kind: 'api_key', value: 'sk-ant-final' });
  });

  it('shows an error message when key validation fails', async () => {
    const io = makeIo(['1', 'invalid', 'sk-ant-ok', '1', '30', '5.0']);
    await runAnthropic({ state: makeState(), io });

    expect(io.output()).toContain('sk-ant-');
  });
});

// ── CLAUDE_CODE_OAUTH_TOKEN validation ────────────────────────────────────────

describe('runAnthropic — CLAUDE_CODE_OAUTH_TOKEN validation', () => {
  it('re-prompts when token is shorter than 20 chars', async () => {
    // 'tooshort' = 8 chars (< 20); second token is ≥ 20 chars
    const io = makeIo(['2', 'tooshort', 'a-valid-oauth-token-12345', '1', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.anthropic).toEqual({
      kind: 'oauth_token',
      value: 'a-valid-oauth-token-12345',
    });
    expect(io.output()).toContain('20 characters');
  });

  it('accepts a token that is exactly 20 chars', async () => {
    const exactly20 = 'a'.repeat(20);
    const io = makeIo(['2', exactly20, '1', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.anthropic).toEqual({ kind: 'oauth_token', value: exactly20 });
  });
});

// ── Defaults ──────────────────────────────────────────────────────────────────

describe('runAnthropic — defaults', () => {
  it('applies default auth kind (api_key) when user presses Enter', async () => {
    // '' → default api_key; then provide valid key; '' defaults for rest
    const io = makeIo(['', 'sk-ant-defkey', '', '', '']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.anthropic).toMatchObject({ kind: 'api_key' });
  });

  it('applies default LOG_LEVEL (info) when user presses Enter', async () => {
    const io = makeIo(['1', 'sk-ant-defkey', '', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['LOG_LEVEL']).toBe('info');
  });

  it('applies default WORK_POLL_S (30) when user presses Enter', async () => {
    const io = makeIo(['1', 'sk-ant-defkey', '1', '', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['WORK_POLL_S']).toBe(30);
  });

  it('applies default CLAUDE_COST_LIMIT_USD (5.0) when user presses Enter', async () => {
    const io = makeIo(['1', 'sk-ant-defkey', '1', '30', '']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['CLAUDE_COST_LIMIT_USD']).toBe(5.0);
  });
});

// ── WORK_POLL_S validation ────────────────────────────────────────────────────

describe('runAnthropic — WORK_POLL_S validation', () => {
  it('re-prompts when value is not an integer', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', 'notanumber', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['WORK_POLL_S']).toBe(30);
    expect(io.output()).toContain('integer');
  });

  it('re-prompts when value is below minimum (5)', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '4', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['WORK_POLL_S']).toBe(30);
  });

  it('accepts minimum value (5)', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '5', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['WORK_POLL_S']).toBe(5);
  });

  it('re-prompts when value exceeds maximum (3600)', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '3601', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['WORK_POLL_S']).toBe(30);
  });

  it('accepts maximum value (3600)', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '3600', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['WORK_POLL_S']).toBe(3600);
  });

  it('re-prompts when value is a float', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '10.5', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['WORK_POLL_S']).toBe(30);
  });
});

// ── CLAUDE_COST_LIMIT_USD validation ──────────────────────────────────────────

describe('runAnthropic — CLAUDE_COST_LIMIT_USD validation', () => {
  it('re-prompts when value is not a number', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '30', 'abc', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['CLAUDE_COST_LIMIT_USD']).toBe(5.0);
    expect(io.output()).toContain('positive number');
  });

  it('re-prompts when value is zero', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '30', '0', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['CLAUDE_COST_LIMIT_USD']).toBe(5.0);
  });

  it('re-prompts when value is negative', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '30', '-1', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['CLAUDE_COST_LIMIT_USD']).toBe(5.0);
  });

  it('accepts a small positive float', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '30', '0.01']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['CLAUDE_COST_LIMIT_USD']).toBeCloseTo(0.01);
  });

  it('accepts a large value', async () => {
    const io = makeIo(['1', 'sk-ant-key', '1', '30', '100']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['CLAUDE_COST_LIMIT_USD']).toBe(100);
  });

  it('re-prompts when value has trailing junk (e.g. "5abc")', async () => {
    // Number('5abc') is NaN; parseFloat('5abc') was 5 — validates the tighter check.
    const io = makeIo(['1', 'sk-ant-key', '1', '30', '5abc', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });

    expect(result.tunables?.['CLAUDE_COST_LIMIT_USD']).toBe(5.0);
    expect(io.output()).toContain('positive number');
  });
});

// ── PromptCancelled on EOF ────────────────────────────────────────────────────

describe('runAnthropic — EOF / PromptCancelled', () => {
  it('throws PromptCancelled when stdin ends during the secret prompt', async () => {
    // Write the auth-kind choice ('1' = api_key) so askChoice resolves, then
    // let stdin end naturally (makeIo ends stdin after the last line).
    // askMasked is then waiting when stdin ends with an empty buffer → PromptCancelled.
    const io = makeIo(['1']);  // only one line; stdin ends immediately after
    const promise = runAnthropic({ state: makeState(), io });
    void promise.catch(() => {});
    await expect(promise).rejects.toBeInstanceOf(PromptCancelled);
  });
});

// ── LOG_LEVEL choices ─────────────────────────────────────────────────────────

describe('runAnthropic — LOG_LEVEL choices', () => {
  it('accepts debug (key 2)', async () => {
    const io = makeIo(['1', 'sk-ant-key', '2', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });
    expect(result.tunables?.['LOG_LEVEL']).toBe('debug');
  });

  it('accepts warn (key 3)', async () => {
    const io = makeIo(['1', 'sk-ant-key', '3', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });
    expect(result.tunables?.['LOG_LEVEL']).toBe('warn');
  });

  it('accepts error (key 4)', async () => {
    const io = makeIo(['1', 'sk-ant-key', '4', '30', '5.0']);
    const result = await runAnthropic({ state: makeState(), io });
    expect(result.tunables?.['LOG_LEVEL']).toBe('error');
  });
});
