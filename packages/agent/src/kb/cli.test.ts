/**
 * Tests for the agentify-kb CLI (packages/agent/src/kb/cli.ts).
 *
 * Coverage:
 *   Part A — Unit tests for `validateKbPageName` (page-name.ts)
 *   Part B — CLI integration tests: page-name validation at `main()` boundaries
 *   Part C — Functional integration tests: append / read / list subcommands
 *
 * Mocking strategy (Part C):
 *   • `execFile` from `node:child_process` is fully mocked — no real git invocations.
 *   • `readFile`, `writeFile`, `readdir`, `stat` from `node:fs/promises` are mocked.
 *   • The `--file` flag is used in append tests so stdin is never read.
 *   • `vi.useFakeTimers()` controls both `new Date()` (for date-stamp assertions)
 *     and `setTimeout` (for retry-backoff timing) — no real-clock delays.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './cli.js';
import { validateKbPageName } from './page-name.js';

// ── Hoisted mocks (initialised before vi.mock factories run) ──────────────────

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
const { mockReadFile, mockWriteFile, mockReaddir, mockStat } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
}));

// ── Module-level mocks ────────────────────────────────────────────────────────
//
// cli.ts does:  const exec = promisify(execFile);
// vi.mock replaces execFile with mockExecFile before cli.ts is imported, so
// promisify(mockExecFile) is captured at module-load time.
//
// Our mock implementations must call their LAST argument as the Node-style
// callback so promisify can resolve/reject the returned promise:
//   success → cb(null, { stdout, stderr })
//   failure → cb(new Error(...))

vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  readdir: mockReaddir,
  stat: mockStat,
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Part A — validateKbPageName unit tests
// ═══════════════════════════════════════════════════════════════════════════════

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
});

describe('validateKbPageName — boundary (stem length)', () => {
  it('accepts 196-char body after KB- prefix (at regex limit)', () => {
    const name = 'KB-' + 'a'.repeat(196);
    expect(name.length).toBe(199);
    expect(() => validateKbPageName(name)).not.toThrow();
  });

  it('rejects 197-char body after KB- prefix (one over limit)', () => {
    const name = 'KB-' + 'a'.repeat(197);
    expect(name.length).toBe(200);
    expect(() => validateKbPageName(name)).toThrow(/refusing invalid page name/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Part B — CLI integration tests: page-name validation at main() boundaries
// ═══════════════════════════════════════════════════════════════════════════════

/** Helper: extract exit code from a mocked process.exit throw. */
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
    // readdir used by cmdList; default to empty so list exits cleanly
    mockReaddir.mockResolvedValue([]);
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
    // Default: readFile fails — simulates missing wiki page (exit 3 for valid names)
    mockReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects AGENTIFY_PERSONA=../../etc/passwd (path traversal via env)', async () => {
    const err = await main(['node', 'kb', 'read', 'persona'], {
      KB_CLONE_DIR: '/tmp/fake-wiki',
      AGENTIFY_PERSONA: '../../etc/passwd',
    }).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(2);
    expect(stderrChunks.join('')).toMatch(/refusing invalid page name/);
  });

  it('rejects persona name containing NUL byte (via env)', async () => {
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
    const err = await main(['node', 'kb', 'read', 'persona'], {
      KB_CLONE_DIR: '/tmp/fake-wiki',
      AGENTIFY_PERSONA: 'tinkerer',
    }).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(3);
    expect(stderrChunks.join('')).not.toMatch(/refusing invalid page name/);
  });

  it('accepts KB-Global (global scope, exits 3: file not found)', async () => {
    const err = await main(['node', 'kb', 'read', 'global'], {
      KB_CLONE_DIR: '/tmp/fake-wiki',
      AGENTIFY_PERSONA: 'tinkerer',
    }).catch((e: unknown) => e);
    expect(exitCodeFrom(err) ?? exitCode).toBe(3);
    expect(stderrChunks.join('')).not.toMatch(/refusing invalid page name/);
  });
});

describe('main — persona page-name validation via --persona argv (cmdAppend)', () => {
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

// ═══════════════════════════════════════════════════════════════════════════════
// Part C — Functional integration tests
// ═══════════════════════════════════════════════════════════════════════════════

// ── Shared fixtures ───────────────────────────────────────────────────────────

/** Minimal bootstrap page with a leading `---` separator (as created by WikiManager). */
const BOOTSTRAP_PAGE = '# KB: Global\n\n> Shared knowledge base for this repo.\n\n---\n';
const BOOTSTRAP_PERSONA_PAGE = '# KB: Tinkerer\n\n> Tinkerer persona lore.\n\n---\n';

/** Fake SHA returned by the mocked `git rev-parse HEAD`. */
const FAKE_SHA = 'deadbeef1234567890abcdef12345678';

/** Env shared across functional tests. */
const FUNC_ENV = {
  KB_CLONE_DIR: '/fake/wiki',
  AGENTIFY_PERSONA: 'tinkerer',
  AGENTIFY_JOB_ID: 'j_test',
  KB_GLOBAL_PAGE: 'KB-Global',
  KB_PAGE_PREFIX: 'KB-',
  KB_WRITE_RETRY_MAX: '3',
  KB_ENTRY_MAX_BYTES: '2048',
};

/**
 * Configure mockExecFile so all git commands succeed.
 * rev-parse returns FAKE_SHA; all others return empty stdout.
 */
function setupGitSuccess(): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, result?: unknown) => void,
    ) => {
      if (args.includes('rev-parse')) {
        cb(null, { stdout: `${FAKE_SHA}\n`, stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    },
  );
}

/** Create a non-fast-forward push rejection error matching cli.ts isPushConflict(). */
function makeNffError(): Error {
  return new Error('git push --force-with-lease failed: [rejected] non-fast-forward');
}

// ── C1: append — happy path ───────────────────────────────────────────────────

describe('cmdAppend — happy path (builtin persona: tinkerer)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[];
  let stdoutChunks: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T00:00:00.000Z'));

    stderrChunks = [];
    stdoutChunks = [];

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 1})`);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    mockStat.mockResolvedValue({});
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === '/fake/body.txt') return 'My KB finding\n\nMore details here.';
      if (p.endsWith('KB-Global.md')) return BOOTSTRAP_PAGE;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    });

    setupGitSuccess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stamps date, source link, job id, and persona signature in written content', async () => {
    await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt', '--from-issue', '42'],
      FUNC_ENV,
    );

    expect(exitSpy).not.toHaveBeenCalled();

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
    expect(written).toContain('## 2024-06-15 —');
    expect(written).toContain('#42');
    expect(written).toContain('j_test');
    expect(written).toContain('🔧 **The Tinkerer** · Implementation Specialist');
    expect(written).toContain('My KB finding');
  });

  it('splices entry after the leading --- separator', async () => {
    await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      FUNC_ENV,
    );

    const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
    // The header `---` must appear before the entry heading
    const sepIdx = written.indexOf('---');
    const entryIdx = written.indexOf('## 2024-06-15');
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    expect(entryIdx).toBeGreaterThan(sepIdx);
  });

  it('invokes git add, commit, push, and rev-parse exactly once each', async () => {
    await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      FUNC_ENV,
    );

    const calls = mockExecFile.mock.calls.map((c) => c[1] as string[]);
    expect(calls.filter((a) => a.includes('add'))).toHaveLength(1);
    expect(calls.filter((a) => a.includes('commit'))).toHaveLength(1);
    expect(calls.filter((a) => a.includes('push'))).toHaveLength(1);
    expect(calls.filter((a) => a.includes('rev-parse'))).toHaveLength(1);
  });

  it('emits a JSON line to stdout with correct fields', async () => {
    await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt', '--from-issue', '99'],
      FUNC_ENV,
    );

    const output = stdoutChunks.join('').trim();
    const json = JSON.parse(output) as Record<string, unknown>;
    expect(json).toMatchObject({
      page: 'KB-Global',
      scope: 'global',
      sha: FAKE_SHA,
      conflicts: 0,
    });
    expect(typeof json['bytes']).toBe('number');
    expect((json['bytes'] as number)).toBeGreaterThan(0);
  });

  it('uses raw persona value as signature for custom personas not in PERSONA_DEFAULTS', async () => {
    const customEnv = { ...FUNC_ENV, AGENTIFY_PERSONA: 'my-custom-bot' };

    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === '/fake/body.txt') return 'Custom bot finding';
      if (p.endsWith('KB-My-custom-bot.md')) return BOOTSTRAP_PERSONA_PAGE;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    });

    await main(
      ['node', 'kb', 'append', 'persona', '--file', '/fake/body.txt'],
      customEnv,
    );

    expect(exitSpy).not.toHaveBeenCalled();
    const [, written] = mockWriteFile.mock.calls[0] as [string, string, string];
    // Custom persona → raw name used as signature (no emoji/title lookup)
    expect(written).toContain('— my-custom-bot');
  });
});

// ── C2: append — idempotency ──────────────────────────────────────────────────

describe('cmdAppend — idempotency (two calls produce two distinct entries)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T00:00:00.000Z'));

    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code ?? 1})`);
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    mockStat.mockResolvedValue({});
    setupGitSuccess();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('produces two separate entries; git commit called twice; no deduplication', async () => {
    // Simulate stateful page: writeFile updates what readFile returns
    let currentPage = BOOTSTRAP_PAGE;
    mockReadFile.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === '/fake/body.txt') return 'Repeated finding';
      if (p.endsWith('KB-Global.md')) return currentPage;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    });
    mockWriteFile.mockImplementation(async (_path: unknown, content: unknown) => {
      currentPage = content as string;
    });

    const argv = ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'];
    await main(argv, FUNC_ENV);
    const afterFirst = currentPage;

    await main(argv, FUNC_ENV);
    const afterSecond = currentPage;

    // Each call produces different content
    expect(afterFirst).not.toBe(BOOTSTRAP_PAGE);
    expect(afterSecond).not.toBe(afterFirst);

    // Second page should have at least two `---` separators (two entries)
    const sepCount = (afterSecond.match(/^---$/gm) ?? []).length;
    expect(sepCount).toBeGreaterThanOrEqual(2);

    // git commit invoked twice — append-only, no dedup
    const commitCalls = mockExecFile.mock.calls.filter((c) =>
      (c[1] as string[]).includes('commit'),
    );
    expect(commitCalls).toHaveLength(2);
  });
});

// ── C3: append — empty body rejected ─────────────────────────────────────────

describe('cmdAppend — empty body rejected', () => {
  let exitCode: number | undefined;
  let stderrChunks: string[];

  beforeEach(() => {
    exitCode = undefined;
    stderrChunks = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : Number(code ?? 1);
      throw new Error(`process.exit(${exitCode})`);
    });

    // Body file returns whitespace-only content
    mockReadFile.mockResolvedValue('   \n  ');
    mockStat.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 2 with "empty entry" on stderr', async () => {
    const err = await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      FUNC_ENV,
    ).catch((e: unknown) => e);

    expect(exitCodeFrom(err) ?? exitCode).toBe(2);
    expect(stderrChunks.join('')).toContain('empty entry');
  });

  it('makes no git invocations when body is empty', async () => {
    await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      FUNC_ENV,
    ).catch(() => undefined);

    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ── C4: append — oversize body rejected ──────────────────────────────────────

describe('cmdAppend — oversize body rejected', () => {
  let exitCode: number | undefined;
  let stderrChunks: string[];

  beforeEach(() => {
    exitCode = undefined;
    stderrChunks = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : Number(code ?? 1);
      throw new Error(`process.exit(${exitCode})`);
    });

    mockStat.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 2 with "exceeds" on stderr when body > KB_ENTRY_MAX_BYTES', async () => {
    // Limit 100 bytes, body is 101 bytes
    mockReadFile.mockResolvedValue('x'.repeat(101));

    const err = await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      { ...FUNC_ENV, KB_ENTRY_MAX_BYTES: '100' },
    ).catch((e: unknown) => e);

    expect(exitCodeFrom(err) ?? exitCode).toBe(2);
    expect(stderrChunks.join('')).toContain('exceeds');
    expect(stderrChunks.join('')).toContain('100');
  });

  it('makes no git invocations when body is oversize', async () => {
    mockReadFile.mockResolvedValue('x'.repeat(101));

    await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      { ...FUNC_ENV, KB_ENTRY_MAX_BYTES: '100' },
    ).catch(() => undefined);

    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ── C5: append — page missing rejected ───────────────────────────────────────

describe('cmdAppend — page-missing rejected', () => {
  let exitCode: number | undefined;
  let stderrChunks: string[];

  beforeEach(() => {
    exitCode = undefined;
    stderrChunks = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : Number(code ?? 1);
      throw new Error(`process.exit(${exitCode})`);
    });

    // Body reads fine, but stat check for the KB page fails
    mockReadFile.mockImplementation(async (path: unknown) => {
      if (String(path) === '/fake/body.txt') return 'Some valid entry body';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 3 with "wiki not initialized" on stderr', async () => {
    const err = await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      FUNC_ENV,
    ).catch((e: unknown) => e);

    expect(exitCodeFrom(err) ?? exitCode).toBe(3);
    expect(stderrChunks.join('')).toContain('wiki not initialized');
  });

  it('makes no git invocations when target page is absent', async () => {
    await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      FUNC_ENV,
    ).catch(() => undefined);

    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ── C6: push conflict + rebase + retry success ────────────────────────────────

describe('cmdAppend — push conflict + rebase + retry success', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrChunks: string[];
  let stdoutChunks: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T00:00:00.000Z'));

    stderrChunks = [];
    stdoutChunks = [];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code ?? 1})`);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    mockStat.mockResolvedValue({});
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockImplementation(async (path: unknown) => {
      if (String(path) === '/fake/body.txt') return 'Conflict retry test entry';
      return BOOTSTRAP_PAGE;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries on non-fast-forward, invokes git pull --rebase once, then succeeds', async () => {
    let pushCount = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, result?: unknown) => void,
      ) => {
        if (args.includes('push')) {
          pushCount++;
          if (pushCount === 1) {
            cb(makeNffError()); // first push: non-fast-forward
          } else {
            cb(null, { stdout: '', stderr: '' }); // retry: success
          }
          return;
        }
        if (args.includes('rev-parse')) {
          cb(null, { stdout: `${FAKE_SHA}\n`, stderr: '' });
          return;
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const promise = main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt', '--from-issue', '99'],
      { ...FUNC_ENV, KB_WRITE_RETRY_MAX: '3' },
    );
    await vi.runAllTimersAsync();
    await promise;

    expect(exitSpy).not.toHaveBeenCalled();

    // git pull --rebase invoked exactly once
    const pullCalls = mockExecFile.mock.calls.filter(
      (c) => (c[1] as string[]).includes('pull') && (c[1] as string[]).includes('--rebase'),
    );
    expect(pullCalls).toHaveLength(1);

    // Two push attempts in total
    expect(pushCount).toBe(2);

    // JSON output reports conflict count
    const json = JSON.parse(stdoutChunks.join('').trim()) as Record<string, unknown>;
    expect(json['conflicts']).toBe(1);
    expect(json['sha']).toBe(FAKE_SHA);
  });

  it('does not emit any error-level stderr on a successful retry', async () => {
    let pushCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
        if (args.includes('push')) {
          pushCount++;
          cb(pushCount === 1 ? makeNffError() : null, { stdout: '', stderr: '' });
          return;
        }
        if (args.includes('rev-parse')) {
          cb(null, { stdout: `${FAKE_SHA}\n`, stderr: '' });
          return;
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const promise = main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      FUNC_ENV,
    );
    await vi.runAllTimersAsync();
    await promise;

    expect(stderrChunks.join('')).not.toMatch(/error|fail|exhausted/i);
  });
});

// ── C7: push retries exhausted ────────────────────────────────────────────────

describe('cmdAppend — push retries exhausted', () => {
  let exitCode: number | undefined;
  let stderrChunks: string[];

  beforeEach(() => {
    vi.useFakeTimers();

    exitCode = undefined;
    stderrChunks = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCode = typeof code === 'number' ? code : Number(code ?? 1);
      throw new Error(`process.exit(${exitCode})`);
    });

    mockStat.mockResolvedValue({});
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockImplementation(async (path: unknown) => {
      if (String(path) === '/fake/body.txt') return 'Retry exhausted test';
      return BOOTSTRAP_PAGE;
    });

    // Every push attempt fails with non-fast-forward
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) => {
        if (args.includes('push')) {
          cb(makeNffError());
          return;
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exits 4 after KB_WRITE_RETRY_MAX push failures', async () => {
    // Attach .catch() immediately so the rejection from process.exit(4)
    // (which fires inside vi.runAllTimersAsync) is handled and does not
    // escape as an unhandled rejection.
    const caught = main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      { ...FUNC_ENV, KB_WRITE_RETRY_MAX: '3' },
    ).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await caught;

    expect(exitCodeFrom(err) ?? exitCode).toBe(4);
    expect(stderrChunks.join('')).toContain('conflict retry exhausted');
  });

  it('performs exactly KB_WRITE_RETRY_MAX push attempts before giving up', async () => {
    const caught = main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      { ...FUNC_ENV, KB_WRITE_RETRY_MAX: '3' },
    ).catch(() => undefined);
    await vi.runAllTimersAsync();
    await caught;

    const pushCalls = mockExecFile.mock.calls.filter((c) =>
      (c[1] as string[]).includes('push'),
    );
    expect(pushCalls).toHaveLength(3);
  });
});

// ── C8: read — prints page contents ──────────────────────────────────────────

describe('cmdRead — prints page contents verbatim to stdout', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[];

  beforeEach(() => {
    stdoutChunks = [];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code ?? 1})`);
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints global page contents verbatim without git invocations', async () => {
    const pageContent =
      '# KB: Global\n\n> Shared.\n\n---\n\n## 2024-01-01 — An entry (j_abc)\n\n— 🔧 **The Tinkerer** · Implementation Specialist\n';
    mockReadFile.mockResolvedValue(pageContent);

    await main(['node', 'kb', 'read', 'global'], FUNC_ENV);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stdoutChunks.join('')).toBe(pageContent);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('prints persona page contents verbatim', async () => {
    const pageContent = '# KB: Tinkerer\n\n> Persona lore.\n\n---\n';
    mockReadFile.mockResolvedValue(pageContent);

    await main(['node', 'kb', 'read', 'persona'], FUNC_ENV);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stdoutChunks.join('')).toBe(pageContent);
  });

  it('exits 3 when the page file does not exist', async () => {
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const err = await main(['node', 'kb', 'read', 'global'], FUNC_ENV).catch(
      (e: unknown) => e,
    );

    expect(exitCodeFrom(err)).toBe(3);
    expect(stderrChunks.join('')).toContain('wiki not initialized');
  });
});

// ── C9: list — prints filenames sorted ───────────────────────────────────────

describe('cmdList — prints page filenames sorted alphabetically', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[];

  beforeEach(() => {
    stdoutChunks = [];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code ?? 1})`);
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints .md filenames in alphabetical order, one per line', async () => {
    mockReaddir.mockResolvedValue([
      'KB-Tinkerer.md',
      'KB-Global.md',
      'KB-Skeptic.md',
      'README.md',
    ]);

    await main(['node', 'kb', 'list'], FUNC_ENV);

    expect(exitSpy).not.toHaveBeenCalled();
    const lines = stdoutChunks.join('').split('\n').filter(Boolean);
    expect(lines).toEqual(['KB-Global.md', 'KB-Skeptic.md', 'KB-Tinkerer.md', 'README.md']);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('excludes non-.md files from output', async () => {
    mockReaddir.mockResolvedValue(['KB-Global.md', 'some-script.sh', 'notes.txt']);

    await main(['node', 'kb', 'list'], FUNC_ENV);

    const output = stdoutChunks.join('');
    expect(output).toContain('KB-Global.md');
    expect(output).not.toContain('some-script.sh');
    expect(output).not.toContain('notes.txt');
  });

  it('emits no output when directory has no .md files', async () => {
    mockReaddir.mockResolvedValue([]);

    await main(['node', 'kb', 'list'], FUNC_ENV);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stdoutChunks.join('')).toBe('');
  });
});

// ── C10: wiki disabled (KB_CLONE_DIR unset) ───────────────────────────────────

describe('wiki disabled — KB_CLONE_DIR unset', () => {
  let exitCode: number | undefined;
  let stderrChunks: string[];

  const NO_KB_ENV = { AGENTIFY_PERSONA: 'tinkerer' }; // no KB_CLONE_DIR

  beforeEach(() => {
    exitCode = undefined;
    stderrChunks = [];
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

  it('append exits 0 with "KB unavailable" on stderr, no git invocations', async () => {
    const err = await main(
      ['node', 'kb', 'append', 'global', '--file', '/fake/body.txt'],
      NO_KB_ENV,
    ).catch((e: unknown) => e);

    expect(exitCodeFrom(err) ?? exitCode).toBe(0);
    expect(stderrChunks.join('')).toContain('KB unavailable');
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('read exits 0 with "KB unavailable" on stderr, no git invocations', async () => {
    const err = await main(
      ['node', 'kb', 'read', 'global'],
      NO_KB_ENV,
    ).catch((e: unknown) => e);

    expect(exitCodeFrom(err) ?? exitCode).toBe(0);
    expect(stderrChunks.join('')).toContain('KB unavailable');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('list exits 0 with "KB unavailable" on stderr, no git invocations', async () => {
    const err = await main(
      ['node', 'kb', 'list'],
      NO_KB_ENV,
    ).catch((e: unknown) => e);

    expect(exitCodeFrom(err) ?? exitCode).toBe(0);
    expect(stderrChunks.join('')).toContain('KB unavailable');
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockReaddir).not.toHaveBeenCalled();
  });
});
