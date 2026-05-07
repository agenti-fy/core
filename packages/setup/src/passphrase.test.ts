/**
 * passphrase.test.ts — unit tests for the session-passphrase helper.
 *
 * All I/O is injectable via PassThrough streams — no real TTY required.
 * Lines are written one per tick (chained setImmediate) per the pattern
 * documented in KB-Tinkerer.md to avoid readline drain-before-listen races.
 */

import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import {
  getSessionPassphrase,
  PASSPHRASE_ENV_VAR,
  MIN_PASSPHRASE_LENGTH,
} from './passphrase.js';
import { PromptCancelled } from './prompts.js';
import type { IoStreams } from './prompts.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build an IoStreams pair fed by the given lines, one per tick.
 *
 * Lines are written with chained setImmediate so each 'data' listener
 * (used by askMasked) is already attached when its line arrives.
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

/** A no-op IoStreams — should never be read during env-var tests. */
function makeUnusedIo(): IoStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  // End immediately so any accidental read fails fast.
  setImmediate(() => stdin.end());
  return { stdin, stdout };
}

// ── Env-var path ──────────────────────────────────────────────────────────

describe('getSessionPassphrase — env var path', () => {
  it('returns the env var value without prompting', async () => {
    const io = makeUnusedIo();
    const result = await getSessionPassphrase(io, {
      env: { [PASSPHRASE_ENV_VAR]: 'topsecretpassword' },
    });
    expect(result).toBe('topsecretpassword');
  });

  it('uses process.env when opts.env is omitted', async () => {
    const original = process.env[PASSPHRASE_ENV_VAR];
    try {
      process.env[PASSPHRASE_ENV_VAR] = 'environmentpassphrase';
      const io = makeUnusedIo();
      const result = await getSessionPassphrase(io);
      expect(result).toBe('environmentpassphrase');
    } finally {
      if (original === undefined) {
        delete process.env[PASSPHRASE_ENV_VAR];
      } else {
        process.env[PASSPHRASE_ENV_VAR] = original;
      }
    }
  });

  it('rejects an empty env var value', async () => {
    const io = makeUnusedIo();
    await expect(
      getSessionPassphrase(io, { env: { [PASSPHRASE_ENV_VAR]: '' } }),
    ).rejects.toThrow(`minimum of ${MIN_PASSPHRASE_LENGTH} characters`);
  });

  it('rejects a too-short env var value', async () => {
    const io = makeUnusedIo();
    await expect(
      getSessionPassphrase(io, { env: { [PASSPHRASE_ENV_VAR]: 'short' } }),
    ).rejects.toThrow(`minimum of ${MIN_PASSPHRASE_LENGTH} characters`);
  });

  it('rejects an env var value of exactly MIN_PASSPHRASE_LENGTH - 1 chars', async () => {
    const io = makeUnusedIo();
    const tooShort = 'a'.repeat(MIN_PASSPHRASE_LENGTH - 1);
    await expect(
      getSessionPassphrase(io, { env: { [PASSPHRASE_ENV_VAR]: tooShort } }),
    ).rejects.toThrow(`minimum of ${MIN_PASSPHRASE_LENGTH} characters`);
  });

  it('accepts an env var value of exactly MIN_PASSPHRASE_LENGTH chars', async () => {
    const io = makeUnusedIo();
    const exact = 'a'.repeat(MIN_PASSPHRASE_LENGTH);
    const result = await getSessionPassphrase(io, {
      env: { [PASSPHRASE_ENV_VAR]: exact },
    });
    expect(result).toBe(exact);
  });
});

// ── Interactive path (resume, confirm: false) ─────────────────────────────

describe('getSessionPassphrase — interactive path (no confirm)', () => {
  it('returns the typed passphrase when no env var is set', async () => {
    const io = makeIo(['goodpassphrase1']);
    const result = await getSessionPassphrase(io, { env: {} });
    expect(result).toBe('goodpassphrase1');
  });

  it('rejects a too-short interactive passphrase', async () => {
    const io = makeIo(['tooshort']);
    await expect(
      getSessionPassphrase(io, { env: {} }),
    ).rejects.toThrow(`minimum of ${MIN_PASSPHRASE_LENGTH} characters`);
  });

  it('propagates PromptCancelled on EOF with no input', async () => {
    const io = makeIo([]);
    const promise = getSessionPassphrase(io, { env: {} });
    void promise.catch(() => {});
    await expect(promise).rejects.toBeInstanceOf(PromptCancelled);
  });
});

// ── Interactive confirm path (init, confirm: true) ────────────────────────

describe('getSessionPassphrase — interactive path (confirm: true)', () => {
  it('returns the passphrase when both entries match', async () => {
    const io = makeIo(['goodpassphrase1', 'goodpassphrase1']);
    const result = await getSessionPassphrase(io, { env: {}, confirm: true });
    expect(result).toBe('goodpassphrase1');
  });

  it('rejects when the two entries differ', async () => {
    const io = makeIo(['goodpassphrase1', 'differentpassphrase']);
    await expect(
      getSessionPassphrase(io, { env: {}, confirm: true }),
    ).rejects.toThrow('do not match');
  });

  it('rejects when the first entry is too short (before confirmation)', async () => {
    // Validation happens before the second prompt.
    const io = makeIo(['tooshort']);
    await expect(
      getSessionPassphrase(io, { env: {}, confirm: true }),
    ).rejects.toThrow(`minimum of ${MIN_PASSPHRASE_LENGTH} characters`);
  });
});
