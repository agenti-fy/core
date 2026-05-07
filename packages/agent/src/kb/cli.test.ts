/**
 * Tests for KB page-name validation in agentify-kb CLI.
 *
 * Coverage:
 *   - Unit tests for `validateKbPageName` (packages/agent/src/kb/page-name.ts)
 *   - Integration tests for `main()` verifying validation fires at the correct
 *     CLI boundaries (KB_GLOBAL_PAGE startup check, resolved persona page name).
 *
 * Integration-test strategy:
 *   `main()` calls `process.exit()` on validation failure. We spy on
 *   `process.exit` and `process.stderr.write` to capture behavior without
 *   spawning a subprocess or terminating the test process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './cli.js';
import { validateKbPageName } from './page-name.js';

// ── validateKbPageName unit tests ─────────────────────────────────────────────

describe('validateKbPageName — positive (accepted names)', () => {
  it('accepts KB-Tinkerer (resolved from AGENTIFY_PERSONA=tinkerer)', () => {
    expect(() => validateKbPageName('KB-Tinkerer')).not.toThrow();
  });

  it('accepts KB-Global (default global page)', () => {
    expect(() => validateKbPageName('KB-Global')).not.toThrow();
  });

  it('accepts KB-My-Bot (hyphenated persona)', () => {
    expect(() => validateKbPageName('KB-My-Bot')).not.toThrow();
  });

  it('accepts KB-bot_v2 (underscore persona)', () => {
    expect(() => validateKbPageName('KB-bot_v2')).not.toThrow();
  });
});

describe('validateKbPageName — negative (rejected names)', () => {
  it('rejects path traversal: ../../etc/passwd', () => {
    expect(() => validateKbPageName('../../etc/passwd')).toThrow(
      /refusing invalid page name/,
    );
  });

  it('rejects KB_GLOBAL_PAGE=foo/bar (slash in value)', () => {
    expect(() => validateKbPageName('foo/bar')).toThrow(/refusing invalid page name/);
  });

  it('rejects KB_GLOBAL_PAGE=../escape (path traversal)', () => {
    expect(() => validateKbPageName('../escape')).toThrow(/refusing invalid page name/);
  });

  it('rejects name containing NUL byte', () => {
    // NUL is checked before anything else; message omits the name for safety.
    expect(() => validateKbPageName('KB-foo\0bar')).toThrow(/NUL byte/);
  });

  it('rejects standalone NUL byte as name', () => {
    expect(() => validateKbPageName('\0')).toThrow(/NUL byte/);
  });

  it('rejects 250-char persona (way over limit)', () => {
    const name = 'KB-' + 'a'.repeat(250);
    expect(() => validateKbPageName(name)).toThrow(/refusing invalid page name/);
  });

  it('rejects name without KB- prefix', () => {
    expect(() => validateKbPageName('Global')).toThrow(/refusing invalid page name/);
  });

  it('rejects name with space (not in allowlist)', () => {
    expect(() => validateKbPageName('KB-My Bot')).toThrow(/refusing invalid page name/);
  });

  it('rejects name with dot (no .md suffix allowed, no . in body)', () => {
    expect(() => validateKbPageName('KB-foo.bar')).toThrow(/refusing invalid page name/);
  });

  it('rejects backslash (Windows path separator)', () => {
    expect(() => validateKbPageName('KB-foo\\bar')).toThrow(
      /path traversal or separator/,
    );
  });

  it('rejects empty string', () => {
    expect(() => validateKbPageName('')).toThrow(/refusing invalid page name/);
  });

  it('rejects KB- alone (body must have ≥ 1 char)', () => {
    expect(() => validateKbPageName('KB-')).toThrow(/refusing invalid page name/);
  });

  it('thrown message does not start with the legacy "kb cli:" prefix', () => {
    let caught: Error | null = null;
    try { validateKbPageName('../escape'); } catch (e) { caught = e as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).not.toMatch(/^kb cli:/);
  });
});

describe('validateKbPageName — boundary (stem length)', () => {
  it('accepts 196-char body after KB- prefix (at regex limit)', () => {
    // stem = "KB-" (3) + 196 chars = 199 chars total
    const name = 'KB-' + 'a'.repeat(196);
    expect(name.length).toBe(199);
    expect(() => validateKbPageName(name)).not.toThrow();
  });

  it('rejects 197-char body after KB- prefix (one over limit)', () => {
    // stem = "KB-" (3) + 197 chars = 200 chars total — exceeds regex {1,196}
    const name = 'KB-' + 'a'.repeat(197);
    expect(name.length).toBe(200);
    expect(() => validateKbPageName(name)).toThrow(/refusing invalid page name/);
  });
});

// ── CLI integration tests ─────────────────────────────────────────────────────
//
// We mock process.exit() so it throws instead of terminating the test process,
// and spy on process.stderr.write to capture error output.
//
// Exit codes:
//   0  KB unavailable (KB_CLONE_DIR not set) — not a validation failure
//   2  Validation failure (bad page name, bad scope, etc.)
//   3  Page not found (wiki not bootstrapped)

/** Helper: captures the exit code thrown by our mocked process.exit. */
function exitCodeFrom(err: unknown): number | undefined {
  if (err instanceof Error && err.message.startsWith('process.exit(')) {
    const match = /process\.exit\((\d+)\)/.exec(err.message);
    return match ? parseInt(match[1] ?? '1', 10) : undefined;
  }
  return undefined;
}

describe('main — KB_GLOBAL_PAGE startup validation', () => {
  let stderrChunks: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    stderrChunks = [];
    exitCode = undefined;
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : Number(code ?? 1);
      throw new Error(`process.exit(${exitCode})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects KB_GLOBAL_PAGE=foo/bar at startup (slash)', async () => {
    const err = await main(['node', 'kb', 'list'], { KB_GLOBAL_PAGE: 'foo/bar' }).catch(
      (e: unknown) => e,
    );
    expect(exitCode).toBe(2);
    expect(stderrChunks.join('')).toMatch(/refusing invalid page name/);
    expect(err).toBeInstanceOf(Error);
  });

  it('rejects KB_GLOBAL_PAGE=../escape at startup (path traversal)', async () => {
    const err = await main(['node', 'kb', 'list'], { KB_GLOBAL_PAGE: '../escape' }).catch(
      (e: unknown) => e,
    );
    expect(exitCode).toBe(2);
    expect(stderrChunks.join('')).toMatch(/refusing invalid page name/);
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts KB_GLOBAL_PAGE=KB-Global (default value, always valid)', async () => {
    // KB_CLONE_DIR not set → list exits 0 (KB unavailable) — not a validation error.
    const err = await main(['node', 'kb', 'list'], { KB_GLOBAL_PAGE: 'KB-Global' }).catch(
      (e: unknown) => e,
    );
    expect(exitCodeFrom(err)).toBe(0);
    expect(stderrChunks.join('')).toContain('KB unavailable');
  });

  it('accepts when KB_GLOBAL_PAGE is unset (defaults to KB-Global)', async () => {
    const err = await main(['node', 'kb', 'list'], {}).catch((e: unknown) => e);
    expect(exitCodeFrom(err)).toBe(0);
  });
});

describe('main — persona page-name validation via AGENTIFY_PERSONA env (cmdRead)', () => {
  // The `read` command does not support a --persona flag; it resolves the
  // persona page name from the AGENTIFY_PERSONA env variable. We test via env.
  let stderrChunks: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    stderrChunks = [];
    exitCode = undefined;
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : Number(code ?? 1);
      throw new Error(`process.exit(${exitCode})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects AGENTIFY_PERSONA=../../etc/passwd (path traversal via env)', async () => {
    // persona '../../etc/passwd' → pascal '../../etc/passwd' → stem 'KB-../../etc/passwd'
    // → contains '..' and '/' → rejected by path-traversal check.
    const err = await main(['node', 'kb', 'read', 'persona'], {
      KB_CLONE_DIR: '/tmp/fake-wiki',
      AGENTIFY_PERSONA: '../../etc/passwd',
    }).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(2);
    expect(stderrChunks.join('')).toMatch(/refusing invalid page name/);
  });

  it('rejects persona name containing NUL byte (via env)', async () => {
    // NUL in the persona propagates into the stem; the NUL-byte check fires first.
    const err = await main(['node', 'kb', 'read', 'persona'], {
      KB_CLONE_DIR: '/tmp/fake-wiki',
      AGENTIFY_PERSONA: 'valid\0name',
    }).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(2);
    expect(stderrChunks.join('')).toMatch(/NUL byte/);
  });

  it('rejects persona name 250 chars long (via env)', async () => {
    const longPersona = 'a'.repeat(250);
    const err = await main(['node', 'kb', 'read', 'persona'], {
      KB_CLONE_DIR: '/tmp/fake-wiki',
      AGENTIFY_PERSONA: longPersona,
    }).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(2);
    expect(stderrChunks.join('')).toMatch(/refusing invalid page name/);
  });

  it('accepts AGENTIFY_PERSONA=tinkerer → KB-Tinkerer (exits 3: file not found)', async () => {
    // Validation passes; exits 3 because the wiki worktree doesn't exist.
    const err = await main(['node', 'kb', 'read', 'persona'], {
      KB_CLONE_DIR: '/tmp/fake-wiki-that-does-not-exist',
      AGENTIFY_PERSONA: 'tinkerer',
    }).catch((e: unknown) => e);
    // Exit 3 = page not found (wiki not bootstrapped) — validation succeeded.
    expect(exitCodeFrom(err) ?? exitCode).toBe(3);
    expect(stderrChunks.join('')).not.toMatch(/refusing invalid page name/);
  });

  it('accepts KB-Global (global scope, exits 3: file not found)', async () => {
    const err = await main(['node', 'kb', 'read', 'global'], {
      KB_CLONE_DIR: '/tmp/fake-wiki-that-does-not-exist',
      AGENTIFY_PERSONA: 'tinkerer',
    }).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(3);
    expect(stderrChunks.join('')).not.toMatch(/refusing invalid page name/);
  });
});

describe('main — persona page-name validation via --persona argv (cmdAppend)', () => {
  // The `append` command supports `--persona <name>` as a test-only escape hatch.
  // Validation fires at step 0 — before any stdin read or fs.* operation.
  let stderrChunks: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    stderrChunks = [];
    exitCode = undefined;
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : Number(code ?? 1);
      throw new Error(`process.exit(${exitCode})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects --persona ../../etc/passwd (path traversal)', async () => {
    // Validation fires before stdin reading — no body is needed.
    const err = await main(
      ['node', 'kb', 'append', 'persona', '--persona', '../../etc/passwd'],
      { KB_CLONE_DIR: '/tmp/fake-wiki' },
    ).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(2);
    expect(stderrChunks.join('')).toMatch(/refusing invalid page name/);
  });

  it('rejects --persona with NUL byte', async () => {
    const err = await main(
      ['node', 'kb', 'append', 'persona', '--persona', 'foo\0bar'],
      { KB_CLONE_DIR: '/tmp/fake-wiki' },
    ).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(2);
    expect(stderrChunks.join('')).toMatch(/NUL byte/);
  });

  it('rejects --persona 250 chars long', async () => {
    const longPersona = 'a'.repeat(250);
    const err = await main(
      ['node', 'kb', 'append', 'persona', '--persona', longPersona],
      { KB_CLONE_DIR: '/tmp/fake-wiki' },
    ).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(2);
    expect(stderrChunks.join('')).toMatch(/refusing invalid page name/);
  });
});
