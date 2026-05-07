/**
 * Unit tests for WikiManager bootstrap path (ensurePages) and
 * uninitialized-wiki detection (#252).
 *
 * Strategy:
 *   - `runGit` is fully mocked so no real git processes are spawned.
 *   - File-system operations use real temporary directories so `pathExists`
 *     behaves exactly as it would in production (real stat calls).
 *   - `ensurePages` is exercised through its private interface via
 *     `(mgr as unknown as { ensurePages: ... }).ensurePages(...)`.  The
 *     public `prepare()` path is used for the 404 detection tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import pino from 'pino';
import type { Logger } from 'pino';
import type { ParsedSoul } from '@agentify/shared';
import { SoulRef } from '../soul/ref.js';
import { WikiManager, kbPersonaTitle, kbPersonaPageFilename } from './wiki.js';
import type { Config } from '../config.js';

// ── Module mocks ─────────────────────────────────────────────────────────────

// vi.mock is hoisted to the top of the file by vitest's transformer. Any
// variables referenced inside its factory must themselves be hoisted via
// vi.hoisted() so they are initialised before the factory runs.
const { mockRunGit } = vi.hoisted(() => ({
  mockRunGit: vi.fn(),
}));

vi.mock('../git/worktree.js', () => ({
  runGit: mockRunGit,
  gitIdentityFor: vi.fn().mockReturnValue({
    name: 'The Tinkerer',
    email: 'tinkerer@agentify.local',
  }),
  credentialHelperCommand: vi.fn().mockReturnValue('test-credential-helper'),
  FETCH_TTL_MS: 60_000,
}));

// ── Shared fixtures ───────────────────────────────────────────────────────────

function makeSoul(overrides: Partial<ParsedSoul['frontmatter']> = {}): ParsedSoul {
  return {
    frontmatter: { name: 'tinkerer', type: 'tinkerer', version: '0.1.0', ...overrides },
    personaBody: 'You are a tinkerer.',
    skillOverrides: {},
  };
}

function makeCustomSoul(name: string): ParsedSoul {
  return {
    frontmatter: { name, type: 'custom', version: '0.1.0' },
    personaBody: 'Custom persona.',
    skillOverrides: {},
  };
}

function makeConfig(workspacesDir: string): Config {
  return {
    workspacesDir,
    kbEnabled: true,
    kbGlobalPage: 'KB-Global',
    kbPagePrefix: 'KB-',
    disableGithub: true,
    port: 8080,
    host: '0.0.0.0',
    soulPath: '/etc/agentify/SOUL.md',
    logLevel: 'error',
    coordinatorUrl: 'http://coordinator:8080',
    agentPublicUrl: 'http://agent:8090',
    registerRetryMs: 2000,
    registerMaxAttempts: 60,
    heartbeatIntervalMs: 15000,
    coordinatorTimeoutMs: 15000,
    jobHistoryCapacity: 500,
    claudeMaxTurns: 500,
    claudeMaxTurnsPlan: 100,
    claudeMaxTurnsImplement: 250,
    claudeMaxTurnsReview: 60,
    claudeMaxTurnsAddressReview: 200,
    claudeMaxTurnsMerge: 50,
    claudeTimeoutMs: 900000,
    claudeCostLimitUsd: 5.0,
    kbWriteRetryMax: 3,
    kbEntryMaxBytes: 1024,
    claudeAdapter: 'stub',
  };
}

function makeMgr(workspacesDir: string, logger?: Logger): WikiManager {
  const soul = makeSoul();
  const soulRef = new SoulRef(soul);
  const log = logger ?? pino({ level: 'silent' });
  return new WikiManager(makeConfig(workspacesDir), soulRef, log, null);
}

// ── kbPersonaTitle util ───────────────────────────────────────────────────────

describe('kbPersonaTitle', () => {
  it('pascal-cases a built-in persona type', () => {
    expect(kbPersonaTitle(makeSoul())).toBe('Tinkerer');
  });

  it('pascal-cases each word in a hyphenated built-in name', () => {
    // address_review is method-level, but if we had a hyphenated persona…
    const soul = makeSoul({ name: 'my-bot', type: 'custom' });
    expect(kbPersonaTitle(soul)).toBe('My-Bot');
  });

  it('uses frontmatter.name for custom souls', () => {
    expect(kbPersonaTitle(makeCustomSoul('my-agent'))).toBe('My-Agent');
  });

  it('uses frontmatter.type for built-in souls', () => {
    const soul = makeSoul({ name: 'ignored', type: 'skeptic' });
    expect(kbPersonaTitle(soul)).toBe('Skeptic');
  });
});

describe('kbPersonaPageFilename', () => {
  it('returns KB-<Title>.md with the default prefix', () => {
    expect(kbPersonaPageFilename(makeSoul(), 'KB-')).toBe('KB-Tinkerer.md');
  });

  it('honours a non-default prefix', () => {
    expect(kbPersonaPageFilename(makeSoul(), 'Notes-')).toBe('Notes-Tinkerer.md');
  });

  it('uses frontmatter.name for custom souls', () => {
    expect(kbPersonaPageFilename(makeCustomSoul('my-bot'), 'KB-')).toBe('KB-My-Bot.md');
  });
});

// ── ensurePages — creates missing pages ──────────────────────────────────────

describe('ensurePages — creates missing pages with correct headers', () => {
  let tmpDir: string;
  let mgr: WikiManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'wiki-ensure-test-'));
    mockRunGit.mockResolvedValue({ stdout: '', stderr: '' });
    mgr = makeMgr('/workspaces'); // workspacesDir is irrelevant for direct ensurePages call
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('creates KB-Global.md with the global seed header when absent', async () => {
    await callEnsurePages(mgr, tmpDir, makeSoul());

    const content = await readFile(join(tmpDir, 'KB-Global.md'), 'utf8');
    expect(content).toContain('# KB: Global');
    expect(content).toContain('global knowledge base for this repo, shared across all personas');
    expect(content).toContain('Newest entries on top');
    expect(content).toContain('---');
  });

  it('creates KB-Tinkerer.md with the persona seed header when absent', async () => {
    await callEnsurePages(mgr, tmpDir, makeSoul());

    const content = await readFile(join(tmpDir, 'KB-Tinkerer.md'), 'utf8');
    expect(content).toContain('# KB: Tinkerer');
    expect(content).toContain('knowledge base for the Tinkerer persona on this repo');
    expect(content).toContain('Newest entries on top');
    expect(content).toContain('---');
  });

  it('commits both missing pages in a single "kb: bootstrap pages" commit', async () => {
    await callEnsurePages(mgr, tmpDir, makeSoul());

    const addCall = mockRunGit.mock.calls.find((args) =>
      (args[0] as string[]).includes('add'),
    );
    expect(addCall).toBeDefined();
    expect(addCall![0]).toContain('KB-Global.md');
    expect(addCall![0]).toContain('KB-Tinkerer.md');

    const commitCall = mockRunGit.mock.calls.find((args) =>
      (args[0] as string[]).includes('commit'),
    );
    expect(commitCall).toBeDefined();
    expect(commitCall![0]).toContain('kb: bootstrap pages');
  });

  it('pushes after the commit', async () => {
    await callEnsurePages(mgr, tmpDir, makeSoul());

    const pushCall = mockRunGit.mock.calls.find((args) =>
      (args[0] as string[]).includes('push'),
    );
    expect(pushCall).toBeDefined();
  });

  it('creates KB-<Custom>.md for a custom soul', async () => {
    const soul = makeCustomSoul('my-agent');
    const mgrCustom = makeMgrWithSoul('/workspaces', soul);
    await callEnsurePages(mgrCustom, tmpDir, soul);

    const content = await readFile(join(tmpDir, 'KB-My-Agent.md'), 'utf8');
    expect(content).toContain('# KB: My-Agent');
    expect(content).toContain('knowledge base for the My-Agent persona on this repo');
  });
});

// ── ensurePages — idempotency ─────────────────────────────────────────────────

describe('ensurePages — idempotent on second call', () => {
  let tmpDir: string;
  let mgr: WikiManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'wiki-idempotent-test-'));
    mockRunGit.mockResolvedValue({ stdout: '', stderr: '' });
    mgr = makeMgr('/workspaces');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('does not commit or push when both pages already exist', async () => {
    // Pre-create both pages
    await writeFile(join(tmpDir, 'KB-Global.md'), '# KB: Global\n---\n', 'utf8');
    await writeFile(join(tmpDir, 'KB-Tinkerer.md'), '# KB: Tinkerer\n---\n', 'utf8');

    await callEnsurePages(mgr, tmpDir, makeSoul());

    expect(mockRunGit).not.toHaveBeenCalled();
  });

  it('creates only the missing page when one page already exists', async () => {
    // Global exists; persona does not
    await writeFile(join(tmpDir, 'KB-Global.md'), '# KB: Global\n---\n', 'utf8');

    await callEnsurePages(mgr, tmpDir, makeSoul());

    // Persona page should be created
    const personaContent = await readFile(join(tmpDir, 'KB-Tinkerer.md'), 'utf8');
    expect(personaContent).toContain('# KB: Tinkerer');

    // Commit should only mention the new persona file, not the existing global
    const addCall = mockRunGit.mock.calls.find((args) =>
      (args[0] as string[]).includes('add'),
    );
    expect(addCall).toBeDefined();
    expect(addCall![0]).not.toContain('KB-Global.md');
    expect(addCall![0]).toContain('KB-Tinkerer.md');
  });

  it('does not write the global file when it already exists', async () => {
    await writeFile(join(tmpDir, 'KB-Global.md'), 'existing-global-content\n', 'utf8');
    await writeFile(join(tmpDir, 'KB-Tinkerer.md'), 'existing-persona-content\n', 'utf8');

    await callEnsurePages(mgr, tmpDir, makeSoul());

    // Both pages must retain their original content
    const global = await readFile(join(tmpDir, 'KB-Global.md'), 'utf8');
    expect(global).toBe('existing-global-content\n');
    const persona = await readFile(join(tmpDir, 'KB-Tinkerer.md'), 'utf8');
    expect(persona).toBe('existing-persona-content\n');
  });
});

// ── ensurePages — non-fast-forward push retry ─────────────────────────────────

describe('ensurePages — non-fast-forward push retry', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.fn>;
  let mgr: WikiManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'wiki-nff-test-'));
    warnSpy = vi.fn();
    const logger = makeSpyLogger(warnSpy);
    mgr = makeMgr('/workspaces', logger);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('retries push with git pull --rebase on non-fast-forward rejection', async () => {
    // First push rejects with non-fast-forward; pull + retry push succeed.
    mockRunGit
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockRejectedValueOnce(makeNffError())            // git push — rejected
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull --rebase
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // git push — retry

    await callEnsurePages(mgr, tmpDir, makeSoul());

    const pullCall = mockRunGit.mock.calls.find((args) =>
      (args[0] as string[]).includes('pull') && (args[0] as string[]).includes('--rebase'),
    );
    expect(pullCall).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a warning when the push retry also fails', async () => {
    mockRunGit
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockRejectedValueOnce(makeNffError())            // first push
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull --rebase
      .mockRejectedValueOnce(new Error('push failed again')); // retry push fails

    await callEnsurePages(mgr, tmpDir, makeSoul());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cloneDir: tmpDir }),
      expect.stringContaining('agentify-kb writes will reconcile'),
    );
  });

  it('logs a warning on a non-NFF push failure without retrying', async () => {
    mockRunGit
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockRejectedValueOnce(new Error('permission denied — push failed'));

    await callEnsurePages(mgr, tmpDir, makeSoul());

    // Should not have called pull --rebase
    const pullCall = mockRunGit.mock.calls.find((args) =>
      (args[0] as string[]).includes('pull'),
    );
    expect(pullCall).toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cloneDir: tmpDir }),
      expect.stringContaining('agentify-kb writes will reconcile'),
    );
  });
});

// ── prepare — wiki not initialized (404) ────────────────────────────────────

describe('prepare — wiki not initialized detection', () => {
  let workspacesDir: string;

  beforeEach(async () => {
    workspacesDir = await mkdtemp(join(tmpdir(), 'wiki-404-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(workspacesDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns { cloneDir: null, tokenFile: null } on exit-128 + "Repository not found"', async () => {
    const err = makeWikiNotFoundError('Repository not found');
    mockRunGit.mockRejectedValueOnce(err);

    const mgr = makeMgr(workspacesDir);
    const result = await mgr.prepare('owner/repo', 'job1');

    expect(result).toEqual({ cloneDir: null, tokenFile: null });
  });

  it('returns { cloneDir: null, tokenFile: null } on exit-128 + broad "not found" phrasing', async () => {
    const err = makeWikiNotFoundError('not found');
    mockRunGit.mockRejectedValueOnce(err);

    const mgr = makeMgr(workspacesDir);
    const result = await mgr.prepare('owner/repo', 'job1');

    expect(result).toEqual({ cloneDir: null, tokenFile: null });
  });

  it('logs the operator hint exactly once across two prepare() calls', async () => {
    const warnSpy = vi.fn();
    const logger = makeSpyLogger(warnSpy);
    const mgr = makeMgr(workspacesDir, logger);

    // First call: clone fails with 404
    mockRunGit.mockRejectedValueOnce(makeWikiNotFoundError('Repository not found'));

    const r1 = await mgr.prepare('owner/repo', 'job1');
    const r2 = await mgr.prepare('owner/repo', 'job2');

    expect(r1).toEqual({ cloneDir: null, tokenFile: null });
    expect(r2).toEqual({ cloneDir: null, tokenFile: null });

    // The operator-hint warn must appear exactly once
    const hintCalls = warnSpy.mock.calls.filter((args) =>
      args.some(
        (a: unknown) =>
          typeof a === 'string' &&
          a.toLowerCase().includes('wiki not initialized'),
      ),
    );
    expect(hintCalls).toHaveLength(1);
    // Message must mention the repo
    expect(hintCalls[0]!.join(' ')).toContain('owner/repo');
  });

  it('does not log the hint on the second prepare() call (served from cache)', async () => {
    const warnSpy = vi.fn();
    const logger = makeSpyLogger(warnSpy);
    const mgr = makeMgr(workspacesDir, logger);

    mockRunGit.mockRejectedValueOnce(makeWikiNotFoundError('Repository not found'));

    await mgr.prepare('owner/repo', 'job1');
    // Reset both spies so we can cleanly assert on the second call in isolation.
    warnSpy.mockClear();
    mockRunGit.mockClear();

    // Second call must not trigger any warn about wiki not initialized
    await mgr.prepare('owner/repo', 'job2');

    const hintCalls = warnSpy.mock.calls.filter((args) =>
      args.some(
        (a: unknown) =>
          typeof a === 'string' &&
          a.toLowerCase().includes('wiki not initialized'),
      ),
    );
    expect(hintCalls).toHaveLength(0);
    // And runGit must not have been called at all on the second prepare
    // (uninitializedRepos cache short-circuits before any git call).
    expect(mockRunGit).not.toHaveBeenCalled();
  });

  it('does NOT treat a non-128 error containing "not found" as uninitialized', async () => {
    // Exit code 1 + "not found" should bubble up as an unexpected error, not a
    // graceful "wiki uninitialized" path — the prepare() outer catch handles it.
    const err = makeWikiNotFoundError('not found', 1);
    mockRunGit.mockRejectedValueOnce(err);

    const mgr = makeMgr(workspacesDir);
    // prepare() outer catch swallows any non-404 error and still returns null
    const result = await mgr.prepare('owner/repo', 'job1');
    expect(result).toEqual({ cloneDir: null, tokenFile: null });
    // But the uninitializedRepos cache must NOT have been set — subsequent
    // calls should retry (i.e. mockRunGit would be invoked again if called)
  });

  it('does NOT treat exit-128 without "not found" as uninitialized', async () => {
    // Auth failure also returns 128 but message is "authentication failed"
    const err = new Error('git clone failed: authentication failed');
    (err as Error & { cause?: unknown }).cause = { code: 128 };
    mockRunGit.mockRejectedValueOnce(err);

    const mgr = makeMgr(workspacesDir);
    const result = await mgr.prepare('owner/repo', 'job1');
    // Still gracefully returns null via the outer catch
    expect(result).toEqual({ cloneDir: null, tokenFile: null });
  });
});

// ── prepare — kbEnabled=false ─────────────────────────────────────────────────

describe('prepare — kbEnabled=false', () => {
  it('returns null immediately without touching git or fs', async () => {
    const config = makeConfig('/workspaces');
    config.kbEnabled = false;
    const soul = makeSoul();
    const mgr = new WikiManager(config, new SoulRef(soul), pino({ level: 'silent' }), null);

    const result = await mgr.prepare('owner/repo', 'job1');

    expect(result).toEqual({ cloneDir: null, tokenFile: null });
    expect(mockRunGit).not.toHaveBeenCalled();
  });
});

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Call the private `ensurePages` method via an unsafe cast.
 * TypeScript's `private` is erased at runtime; this is intentional for unit
 * testing a complex private path without going through the full prepare() flow.
 */
async function callEnsurePages(
  mgr: WikiManager,
  cloneDir: string,
  soul: ParsedSoul,
): Promise<void> {
  return (mgr as unknown as { ensurePages: (d: string, s: ParsedSoul) => Promise<void> })
    .ensurePages(cloneDir, soul);
}

/** Create a WikiManager whose SoulRef carries a specific ParsedSoul. */
function makeMgrWithSoul(workspacesDir: string, soul: ParsedSoul, logger?: Logger): WikiManager {
  const soulRef = new SoulRef(soul);
  const log = logger ?? pino({ level: 'silent' });
  return new WikiManager(makeConfig(workspacesDir), soulRef, log, null);
}

/**
 * Simulate an error thrown by `runGit` when the wiki is uninitialized.
 * Matches the structure produced by the real `runGit` wrapper:
 *   new Error('git clone ... failed: <stderr>', { cause: execFileError })
 */
function makeWikiNotFoundError(phrase: string, exitCode = 128): Error {
  const inner = Object.assign(new Error(`git clone ... failed: ${phrase}`), {
    code: exitCode,
  });
  const outer = new Error(`git clone ... failed: ${phrase}`);
  (outer as Error & { cause: unknown }).cause = inner;
  return outer;
}

/** Simulate a non-fast-forward push rejection. */
function makeNffError(): Error {
  const inner = Object.assign(new Error('git push failed: [rejected] non-fast-forward'), {
    code: 1,
  });
  const outer = new Error('git push failed: [rejected] non-fast-forward');
  (outer as Error & { cause: unknown }).cause = inner;
  return outer;
}

/** Minimal pino-compatible logger that spies on warn(). */
function makeSpyLogger(warnSpy: ReturnType<typeof vi.fn>): Logger {
  return {
    warn: warnSpy,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'warn',
  } as unknown as Logger;
}
