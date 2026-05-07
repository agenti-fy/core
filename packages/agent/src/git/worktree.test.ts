/**
 * Unit tests for InstallationTokenCache.ensureFile().
 *
 * These tests use the real class (no vi.mock) and exercise the
 * file-system writes with a stubbed auth function. They verify:
 *   1. Token content and file mode (0600).
 *   2. Atomic write behaviour — no .token.tmp left after resolve.
 *   3. Overwrite with refreshed content on token rotation.
 *
 * All tests are hermetic: each creates a fresh tmpdir and cleans it
 * up in afterEach so failures in one test don't bleed into others.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createAppAuth } from '@octokit/auth-app';
import { InstallationTokenCache } from './worktree.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a stub auth function that always returns `token` with the given
 * `expiresAt` ISO string (defaults to one hour in the future so the
 * in-memory cache considers the result fresh).
 */
function makeAuth(token: string, expiresAt?: string): ReturnType<typeof createAppAuth> {
  const expiry = expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return (async () => ({
    type: 'installation' as const,
    token,
    expiresAt: expiry,
  })) as unknown as ReturnType<typeof createAppAuth>;
}

/**
 * Build a stub auth that returns tokens from `tokens` in order (cycling
 * once the list is exhausted). Sets `expiresAt` to the Unix epoch so the
 * in-memory cache is always stale — every `get()` call re-invokes auth,
 * simulating a token rotation without any real-time waiting.
 */
function makeRotatingAuth(tokens: string[]): ReturnType<typeof createAppAuth> {
  const expiredIso = new Date(0).toISOString();
  let idx = 0;
  return (async () => ({
    type: 'installation' as const,
    token: tokens[idx++ % tokens.length],
    expiresAt: expiredIso,
  })) as unknown as ReturnType<typeof createAppAuth>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InstallationTokenCache.ensureFile', () => {
  let tmpDir: string;
  let tokenFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'token-cache-test-'));
    tokenFile = join(tmpDir, '.token');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes the current token to the supplied path with mode 0600', async () => {
    const cache = new InstallationTokenCache(makeAuth('fake-token-xyz'));

    await cache.ensureFile(tokenFile);

    const content = await readFile(tokenFile, 'utf8');
    expect(content).toBe('fake-token-xyz');

    const s = await stat(tokenFile);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('writes atomically — .token.tmp is renamed away before the call resolves', async () => {
    const cache = new InstallationTokenCache(makeAuth('fake-token-xyz'));

    await cache.ensureFile(tokenFile);

    // After the call resolves, the directory must contain `.token` but NOT
    // `.token.tmp`. The atomic write (tmp + rename) guarantees that no
    // concurrent reader ever observes a half-written file.
    const files = await readdir(tmpDir);
    expect(files).toContain('.token');
    expect(files).not.toContain('.token.tmp');
  });

  it('overwrites an existing token file with refreshed content when the cached token has rotated', async () => {
    // makeRotatingAuth sets expiresAt to epoch (Date(0)), so the in-memory
    // cache is always considered stale: every call to get() re-fetches from
    // auth, advancing through the token list.
    const cache = new InstallationTokenCache(makeRotatingAuth(['token-v1', 'token-v2']));

    // First write: token-v1 is fetched and written.
    await cache.ensureFile(tokenFile);
    expect(await readFile(tokenFile, 'utf8')).toBe('token-v1');

    // Second write: cache is stale → auth returns token-v2 → file is overwritten.
    await cache.ensureFile(tokenFile);
    expect(await readFile(tokenFile, 'utf8')).toBe('token-v2');

    // Mode must remain 0600 after the overwrite.
    const s = await stat(tokenFile);
    expect(s.mode & 0o777).toBe(0o600);
  });
});
