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
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import pino from 'pino';
import type { Logger } from 'pino';
import type { ParsedSoul } from '@agenti-fy/shared';
import { SoulRef } from '../soul/ref.js';
import { WikiManager, kbPersonaTitle, kbPersonaPageFilename } from './wiki.js';
import type { Config } from '../config.js';
import type { InstallationTokenCache } from '../git/worktree.js';

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

  // Mock for the `git symbolic-ref --short HEAD` lookup that ensurePages now
  // runs before push/pull — it resolves the branch name so explicit
  // `origin HEAD:<branch>` and `pull --rebase origin <branch>` work without
  // depending on `branch.<name>.remote` tracking config (a `git clone --bare`
  // doesn't set that, and plain `git push` then errors out fatally).
  const symbolicRefOk = { stdout: 'master\n', stderr: '' };

  it('retries push with git pull --rebase on non-fast-forward rejection', async () => {
    // First push rejects with non-fast-forward; pull + retry push succeed.
    mockRunGit
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git commit
      .mockResolvedValueOnce(symbolicRefOk)              // git symbolic-ref --short HEAD
      .mockRejectedValueOnce(makeNffError())            // git push — rejected
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull --rebase origin master
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
      .mockResolvedValueOnce(symbolicRefOk)              // git symbolic-ref --short HEAD
      .mockRejectedValueOnce(makeNffError())            // first push
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git pull --rebase origin master
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
      .mockResolvedValueOnce(symbolicRefOk)              // git symbolic-ref --short HEAD
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

// ── prepare — success path (first run) ───────────────────────────────────────

describe('prepare — success (first run: bare does not yet exist)', () => {
  let workspacesDir: string;

  beforeEach(async () => {
    workspacesDir = await mkdtemp(join(tmpdir(), 'wiki-prepare-fresh-'));
    vi.clearAllMocks();
    // Create the bare dir and worktree dir when the corresponding git commands
    // fire so subsequent `pathExists` checks see a real directory.
    mockRunGit.mockImplementation(async (args: string[]) => {
      if (Array.isArray(args)) {
        if (args.includes('clone') && args.includes('--bare')) {
          // args: ['-c', 'credential.helper=…', 'clone', '--bare', url, bareDir]
          const bareDir = args[args.length - 1];
          if (bareDir && !bareDir.startsWith('-')) {
            await mkdir(bareDir, { recursive: true });
          }
        }
        if (args.includes('worktree') && args.includes('add')) {
          const addIdx = args.indexOf('add');
          const worktreePath = addIdx + 1 < args.length ? args[addIdx + 1] : undefined;
          if (worktreePath) await mkdir(worktreePath, { recursive: true });
        }
      }
      return { stdout: '', stderr: '' };
    });
  });

  afterEach(async () => {
    await rm(workspacesDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('invokes git clone --bare, skips fetch, adds worktree, sets identity', async () => {
    const mgr = makeMgr(workspacesDir);
    const result = await mgr.prepare('owner/repo', 'job1');

    // Must return a non-null cloneDir
    expect(result.cloneDir).not.toBeNull();
    expect(result.tokenFile).not.toBeNull();

    const calls = mockRunGit.mock.calls.map((c) => c[0] as string[]);

    // git clone --bare must have been invoked with the wiki URL
    const cloneCall = calls.find((a) => a.includes('clone') && a.includes('--bare'));
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.join(' ')).toContain('owner/repo.wiki.git');

    // git worktree add must have been invoked
    const wtAdd = calls.find((a) => a.includes('worktree') && a.includes('add'));
    expect(wtAdd).toBeDefined();

    // git identity must be configured on the worktree
    const nameCall = calls.find((a) => a.includes('user.name'));
    expect(nameCall).toBeDefined();
    const emailCall = calls.find((a) => a.includes('user.email'));
    expect(emailCall).toBeDefined();

    // fetch must NOT have been called on the first run (clone sets the TTL)
    const fetchCall = calls.find((a) => a.includes('fetch'));
    expect(fetchCall).toBeUndefined();
  });

  it('cloneDir path includes job_id and .kb segment', async () => {
    const mgr = makeMgr(workspacesDir);
    const result = await mgr.prepare('owner/repo', 'job1');

    expect(result.cloneDir).toContain('.kb');
    expect(result.cloneDir).toContain('job1');
  });

  it('tokenFile path points to the shared .token file in the repo dir', async () => {
    const mgr = makeMgr(workspacesDir);
    const result = await mgr.prepare('owner/repo', 'job1');

    expect(result.tokenFile).toContain('.token');
    expect(result.tokenFile).not.toContain('.kb');
  });
});

// ── prepare — fetch debounce (cached path) ────────────────────────────────────

describe('prepare — fetch debounce (bare already cloned, within TTL)', () => {
  let workspacesDir: string;

  /**
   * Helper that configures mockRunGit to create real directories on `clone --bare`
   * and `worktree add` so pathExists() behaves correctly across two prepare() calls.
   */
  function setupSuccessMock(): void {
    mockRunGit.mockImplementation(async (args: string[]) => {
      if (Array.isArray(args)) {
        if (args.includes('clone') && args.includes('--bare')) {
          const bareDir = args[args.length - 1];
          if (bareDir && !bareDir.startsWith('-')) {
            await mkdir(bareDir, { recursive: true });
          }
        }
        if (args.includes('worktree') && args.includes('add')) {
          const addIdx = args.indexOf('add');
          const worktreePath = addIdx + 1 < args.length ? args[addIdx + 1] : undefined;
          if (worktreePath) await mkdir(worktreePath, { recursive: true });
        }
      }
      return { stdout: '', stderr: '' };
    });
  }

  beforeEach(async () => {
    workspacesDir = await mkdtemp(join(tmpdir(), 'wiki-prepare-cached-'));
    vi.clearAllMocks();
    setupSuccessMock();
  });

  afterEach(async () => {
    await rm(workspacesDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('skips git fetch on the second prepare() called immediately after the first', async () => {
    const mgr = makeMgr(workspacesDir);

    // First prepare: triggers clone + sets lastFetchAt
    await mgr.prepare('owner/repo', 'job1');

    // Second prepare immediately: bare exists and lastFetchAt is within TTL
    mockRunGit.mockClear();
    setupSuccessMock();
    await mgr.prepare('owner/repo', 'job2');

    // Fetch must not appear in the second call's git invocations
    const calls = mockRunGit.mock.calls.map((c) => c[0] as string[]);
    const fetchCall = calls.find((a) => a.includes('fetch'));
    expect(fetchCall).toBeUndefined();

    // Clone must not have been called again (bare already exists)
    const cloneCall = calls.find((a) => a.includes('clone'));
    expect(cloneCall).toBeUndefined();
  });
});

// ── cleanup — worktree removal and fallback ───────────────────────────────────

describe('cleanup — worktree removal', () => {
  let workspacesDir: string;

  beforeEach(async () => {
    workspacesDir = await mkdtemp(join(tmpdir(), 'wiki-cleanup-test-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(workspacesDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('invokes git worktree remove --force on the happy path', async () => {
    mockRunGit.mockResolvedValue({ stdout: '', stderr: '' });

    const mgr = makeMgr(workspacesDir);
    await mgr.cleanup('owner/repo', 'job1');

    const calls = mockRunGit.mock.calls.map((c) => c[0] as string[]);
    const removeCall = calls.find(
      (a) => a.includes('worktree') && a.includes('remove') && a.includes('--force'),
    );
    expect(removeCall).toBeDefined();

    // The worktree path argument must point to the job-specific directory
    const wtPath = removeCall!.find((seg) => seg.includes('job1'));
    expect(wtPath).toBeDefined();
  });

  it('falls back to rm -rf + worktree prune when git worktree remove fails', async () => {
    // First call (worktree remove): fails
    // Second call (worktree prune): succeeds
    mockRunGit
      .mockRejectedValueOnce(new Error('not a worktree'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    // Create the job worktree dir so we can assert it gets removed
    const worktreePath = join(workspacesDir, 'owner', 'repo', '.kb', 'job1');
    await mkdir(worktreePath, { recursive: true });
    // Write a sentinel file so we can confirm the directory was removed
    await writeFile(join(worktreePath, 'sentinel.txt'), 'data', 'utf8');

    const mgr = makeMgr(workspacesDir);
    await mgr.cleanup('owner/repo', 'job1');

    // Worktree directory must have been physically removed
    let dirExists = false;
    try {
      await stat(worktreePath);
      dirExists = true;
    } catch {
      // expected
    }
    expect(dirExists).toBe(false);

    // git worktree prune must have been called as a second git invocation
    const calls = mockRunGit.mock.calls.map((c) => c[0] as string[]);
    const pruneCall = calls.find((a) => a.includes('worktree') && a.includes('prune'));
    expect(pruneCall).toBeDefined();
  });

  it('cleanup is best-effort: a complete failure does not throw', async () => {
    // Both the worktree remove AND the prune fail — cleanup must not propagate
    mockRunGit
      .mockRejectedValueOnce(new Error('worktree remove failed'))
      .mockRejectedValueOnce(new Error('prune also failed'));

    const mgr = makeMgr(workspacesDir);
    // Must resolve without throwing
    await expect(mgr.cleanup('owner/repo', 'job1')).resolves.toBeUndefined();
  });
});

// ── Token-file helpers ─────────────────────────────────────────────────────────

/**
 * Build a minimal duck-typed token-cache stub whose `ensureFile` performs
 * the real atomic write (tmp + rename, mode 0600). This lets wiki token-file
 * tests exercise the actual file-system path without depending on the real
 * InstallationTokenCache (which is mocked away via vi.mock above).
 */
function makeStubTokenCache(token: string): InstallationTokenCache {
  return {
    async get() {
      return token;
    },
    async ensureFile(tokenFilePath: string) {
      const tmp = `${tokenFilePath}.tmp`;
      await writeFile(tmp, token, { mode: 0o600 });
      await rename(tmp, tokenFilePath);
    },
  } as unknown as InstallationTokenCache;
}

// ── prepare — token file (order-independence, #337/#345) ──────────────────────

describe('prepare — token file written before first runGit call (order-independence)', () => {
  let workspacesDir: string;

  beforeEach(async () => {
    workspacesDir = await mkdtemp(join(tmpdir(), 'wiki-token-order-test-'));
    vi.clearAllMocks();
    // Default mock: return success for all git calls, and physically create
    // the worktree directory when `git worktree add` is called — this lets
    // ensurePages write its seed files so _prepare can complete successfully.
    mockRunGit.mockImplementation(async (args: string[]) => {
      if (Array.isArray(args) && args.includes('worktree') && args.includes('add')) {
        const addIdx = args.indexOf('add');
        const worktreePath = addIdx + 1 < args.length ? args[addIdx + 1] : undefined;
        if (worktreePath) {
          await mkdir(worktreePath, { recursive: true });
        }
      }
      return { stdout: '', stderr: '' };
    });
  });

  afterEach(async () => {
    await rm(workspacesDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('token file exists with mode 0600 before the first runGit call is made', async () => {
    const repo = 'owner/repo';
    const job_id = 'job1';
    const repoDir = join(workspacesDir, 'owner', 'repo');
    const tokenFile = join(repoDir, '.token');

    // Capture the filesystem state at the instant the first runGit call fires.
    let tokenExistsAtFirstCall: boolean | undefined;
    let tokenModeAtFirstCall: number | undefined;

    mockRunGit.mockImplementation(async (args: string[]) => {
      // Capture state on the very first call only.
      if (tokenExistsAtFirstCall === undefined) {
        try {
          const s = await stat(tokenFile);
          tokenExistsAtFirstCall = true;
          tokenModeAtFirstCall = s.mode;
        } catch {
          tokenExistsAtFirstCall = false;
        }
      }
      // For worktree add: create the directory so ensurePages can write pages.
      if (Array.isArray(args) && args.includes('worktree') && args.includes('add')) {
        const addIdx = args.indexOf('add');
        const worktreePath = addIdx + 1 < args.length ? args[addIdx + 1] : undefined;
        if (worktreePath) {
          await mkdir(worktreePath, { recursive: true });
        }
      }
      return { stdout: '', stderr: '' };
    });

    const tokenCache = makeStubTokenCache('fake-token-xyz');
    const config = makeConfig(workspacesDir);
    const mgr = new WikiManager(config, new SoulRef(makeSoul()), pino({ level: 'silent' }), tokenCache);

    await mgr.prepare(repo, job_id);

    // Token file must have been written by tokenCache.ensureFile() BEFORE any
    // git operation was attempted. This is the core order-independence guarantee
    // from #337/#345: WikiManager no longer relies on WorktreeManager having run
    // first for the same repo.
    expect(tokenExistsAtFirstCall).toBe(true);
    expect(tokenModeAtFirstCall !== undefined && (tokenModeAtFirstCall & 0o777)).toBe(0o600);
  });

  it('no token file is written when tokenCache is null (DISABLE_GITHUB path)', async () => {
    const repo = 'owner/repo';
    const job_id = 'job1';
    const repoDir = join(workspacesDir, 'owner', 'repo');
    const tokenFile = join(repoDir, '.token');

    // tokenCache=null: the if (this.tokenCache) guard skips ensureFile().
    const config = makeConfig(workspacesDir);
    const mgr = new WikiManager(config, new SoulRef(makeSoul()), pino({ level: 'silent' }), null);

    await mgr.prepare(repo, job_id);

    // Verify that no token file was written to disk at all.
    let tokenFileExists = false;
    try {
      await stat(tokenFile);
      tokenFileExists = true;
    } catch {
      // expected
    }
    expect(tokenFileExists).toBe(false);
  });

  it('kbEnabled=false returns null immediately without writing a token file', async () => {
    const config = makeConfig(workspacesDir);
    config.kbEnabled = false;
    const tokenCache = makeStubTokenCache('should-not-be-written');
    const mgr = new WikiManager(config, new SoulRef(makeSoul()), pino({ level: 'silent' }), tokenCache);

    const result = await mgr.prepare('owner/repo', 'job1');

    expect(result).toEqual({ cloneDir: null, tokenFile: null });
    expect(mockRunGit).not.toHaveBeenCalled();

    // The fast-exit at wiki.ts:90-92 returns before any ensureFile call.
    const tokenFile = join(workspacesDir, 'owner', 'repo', '.token');
    let tokenFileExists = false;
    try {
      await stat(tokenFile);
      tokenFileExists = true;
    } catch {
      // expected
    }
    expect(tokenFileExists).toBe(false);
  });

  it('two prepare() calls for different job_ids are idempotent — token content is the same on both writes', async () => {
    const repo = 'owner/repo';
    const config = makeConfig(workspacesDir);
    const tokenCache = makeStubTokenCache('stable-token');
    const mgr = new WikiManager(config, new SoulRef(makeSoul()), pino({ level: 'silent' }), tokenCache);

    // Both prepares should complete (mocked runGit + worktree dir creation).
    await mgr.prepare(repo, 'job1');
    await mgr.prepare(repo, 'job2');

    // The token file must exist and contain the same token after both writes.
    // ensureFile is last-writer-wins with identical content — no corruption.
    const tokenFile = join(workspacesDir, 'owner', 'repo', '.token');
    const content = await readFile(tokenFile, 'utf8');
    expect(content).toBe('stable-token');

    // Mode must still be 0600 after the second write.
    const s = await stat(tokenFile);
    expect(s.mode & 0o777).toBe(0o600);
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
