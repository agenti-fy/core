/**
 * KB roundtrip smoke test (Phase 6 of #226, implements #274).
 *
 * Exercises the full KB lifecycle end-to-end through a local bare git repo,
 * with no real Anthropic or GitHub connections:
 *
 *   Step 1 (write)  — SkillRunner.run('implement') with a KbWriteAdapter that
 *                     calls `agentify-kb append persona --from-issue 999` via
 *                     the in-process `main()` export from kb/cli.ts.
 *                     Asserts KB-Tinkerer.md contains the synthetic marker with
 *                     the date stamp, source-issue reference, and persona
 *                     signature footer the helper enforces.
 *
 *   Step 2 (read)   — Second SkillRunner.run('implement') with a KbReadAdapter
 *                     that reads KB_CLONE_DIR from process.env (set by
 *                     SkillRunner before calling adapter.run) and verifies the
 *                     written entry is observable at that path — matching the
 *                     consult step a real Claude run would perform.
 *
 * The "wiki remote" is a local bare repo created in a tmp directory.  A clone
 * of that bare repo serves as the per-job KB worktree (KB_CLONE_DIR).  The
 * FakeWikiManager bypasses the real WikiManager's network path and hands the
 * pre-created worktree directly to SkillRunner.  No git credentials or network
 * access is required.
 *
 * If a future grep finds "synthetic-kb-roundtrip-marker" in any KB page, this
 * test is the sole source; no real agent wrote it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import type { Logger } from 'pino';
import type { ParsedSoul } from '@agentify/shared';
import { SoulRef } from '../soul/ref.js';
import { AgentState } from '../state.js';
import type { Config } from '../config.js';
import type { ClaudeAdapter, SkillRunOptions, SkillRunOutput } from '../claude/adapter.js';
import type { CoordinatorClient } from '../coordinator-client.js';
import type { GitHubAdapter } from '../github/client.js';
import type { WorktreeManager, PreparedWorktree } from '../git/worktree.js';
import type { WikiManager, PreparedWiki } from '../kb/wiki.js';
import { SkillRunner } from '../runner/skill-runner.js';
import { main as kbMain } from '../kb/cli.js';

const exec = promisify(execFile);

// ── Test constants ────────────────────────────────────────────────────────────

/**
 * Fixed synthetic text appended via agentify-kb in the write step.  Any
 * future grep for this string across KB pages uniquely identifies this test.
 */
const SYNTHETIC_MARKER = 'synthetic-kb-roundtrip-marker';
const PERSONA = 'tinkerer';
const REPO = 'acme/api';
const TARGET_ID = 999;

// ── Logging ───────────────────────────────────────────────────────────────────

const silentLog: Logger = pino({ level: 'silent' });

// ── Git identity for test-setup commits ───────────────────────────────────────

/**
 * Env vars forwarded to seed git invocations so the bootstrap commits have a
 * deterministic author/committer even when the CI host has no global git config.
 */
const GIT_SETUP_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test Setup',
  GIT_AUTHOR_EMAIL: 'test@agentify.local',
  GIT_COMMITTER_NAME: 'Test Setup',
  GIT_COMMITTER_EMAIL: 'test@agentify.local',
  GIT_TERMINAL_PROMPT: '0',
};

// ── Soul / config fixtures ────────────────────────────────────────────────────

function makeSoul(): ParsedSoul {
  return {
    frontmatter: { name: PERSONA, type: 'tinkerer', version: '0.1.0' },
    personaBody: 'You are a tinkerer.',
    skillOverrides: {},
  };
}

/**
 * Minimal Config with KB enabled and GitHub disabled.  Only the fields that
 * SkillRunner / resolveSkill / WikiManager touch are meaningful; the rest are
 * typed-but-ignored stubs cast via `as Config`.
 */
function makeConfig(): Config {
  return {
    port: 8080,
    host: '0.0.0.0',
    soulPath: '/dev/null',
    workspacesDir: '/tmp',
    logLevel: 'error',
    coordinatorUrl: 'http://localhost:9000',
    agentPublicUrl: 'http://localhost:8080',
    registerRetryMs: 2000,
    registerMaxAttempts: 60,
    heartbeatIntervalMs: 15000,
    coordinatorTimeoutMs: 15000,
    jobHistoryCapacity: 100,
    claudeMaxTurns: 500,
    claudeMaxTurnsPlan: 100,
    claudeMaxTurnsImplement: 250,
    claudeMaxTurnsReview: 60,
    claudeMaxTurnsAddressReview: 200,
    claudeMaxTurnsMerge: 50,
    claudeTimeoutMs: 900_000,
    claudeCostLimitUsd: 5.0,
    claudeAdapter: 'stub',
    disableGithub: true,
    kbEnabled: true,
    kbGlobalPage: 'KB-Global',
    kbPagePrefix: 'KB-',
    kbWriteRetryMax: 3,
    kbEntryMaxBytes: 1024,
  };
}

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeGitHub implements GitHubAdapter {
  readonly enabled = false;
  async listLabels(): Promise<string[]> { return []; }
  async addLabels(): Promise<void> {}
  async removeLabels(): Promise<void> {}
  async replaceLabels(): Promise<void> {}
  async appendToIssueBody(): Promise<void> {}
  async postIssueComment(): Promise<void> {}
  async getPullRequest(): Promise<null> { return null; }
}

/**
 * Satisfies WorktreeManager's interface; returns a scratch directory as the
 * per-job code worktree so SkillRunner has a valid cwd without cloning GitHub.
 */
class FakeWorktreeManager {
  constructor(private readonly scratch: string) {}
  async prepare(): Promise<PreparedWorktree> {
    mkdirSync(this.scratch, { recursive: true });
    return { path: this.scratch, branch: null };
  }
  async cleanup(): Promise<void> {}
  async getInstallationToken(): Promise<string | null> { return null; }
}

/**
 * Satisfies WikiManager's interface; returns a pre-created local KB worktree
 * path rather than cloning the GitHub wiki.  Both the write and read runs use
 * the same worktree so the file written in step 1 is immediately readable in
 * step 2.
 */
class FakeWikiManager {
  constructor(private readonly kbWorktreePath: string) {}
  async prepare(): Promise<PreparedWiki> {
    return { cloneDir: this.kbWorktreePath, tokenFile: null };
  }
  async cleanup(): Promise<void> {}
  async getInstallationToken(): Promise<string | null> { return null; }
}

class FakeCoordinator {
  async putSession(): Promise<void> {}
}

// ── Runner helper ─────────────────────────────────────────────────────────────

/**
 * Enqueue a SkillRunner job and block until it completes.
 *
 * SkillRunner.enqueue() defers actual execution to a setImmediate callback, so
 * two explicit yields are needed before `inFlight()` has a non-null promise to
 * await.  This mirrors the pattern used in skill-runner.test.ts.
 */
async function runSkill(runner: SkillRunner, jobId: string): Promise<void> {
  runner.enqueue({
    job_id: jobId,
    method: 'implement',
    repo: REPO,
    target_id: TARGET_ID,
    persona_name: PERSONA,
    session_id: null,
  });
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  const inFlight = runner.inFlight();
  if (inFlight) await inFlight;
}

// ── Smoke suite ───────────────────────────────────────────────────────────────

describe('KB roundtrip smoke (write then read through stub adapters)', () => {
  let tmpDir: string;
  let bareDir: string;
  let kbWorktreeDir: string;
  let codeWorkDir: string;
  let bodyFile: string;

  /**
   * Build a local git topology that mimics the wiki remote + per-job worktree:
   *
   *   tmpDir/
   *     wiki.git/      ← bare repo (the "GitHub wiki remote")
   *     seed/          ← temporary clone used only to push the initial pages
   *     kb-wt/         ← regular clone used as KB_CLONE_DIR for both runs
   *     code-wt/       ← scratch dir returned by FakeWorktreeManager
   *     entry-body.txt ← synthetic entry text fed to agentify-kb via --file
   */
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kb-roundtrip-'));
    bareDir = join(tmpDir, 'wiki.git');
    kbWorktreeDir = join(tmpDir, 'kb-wt');
    codeWorkDir = join(tmpDir, 'code-wt');
    bodyFile = join(tmpDir, 'entry-body.txt');

    // The entry body is a single line containing the synthetic marker.
    writeFileSync(bodyFile, SYNTHETIC_MARKER);

    // Initialise the bare "wiki remote".
    mkdirSync(bareDir);
    await exec('git', ['init', '--bare', bareDir], { env: GIT_SETUP_ENV });

    // Seed KB pages via a temporary working-tree clone of the bare repo.
    const seedDir = join(tmpDir, 'seed');
    mkdirSync(seedDir);
    await exec('git', ['init', seedDir], { env: GIT_SETUP_ENV });
    await exec('git', ['-C', seedDir, 'remote', 'add', 'origin', bareDir], { env: GIT_SETUP_ENV });

    // Bootstrap page content mirrors what WikiManager.ensurePages() writes.
    const globalHeader = [
      '# KB: Global',
      '',
      '> Append-only global knowledge base for this repo, shared across all personas.',
      '> Newest entries on top. Each entry is dated and links the work that produced it.',
      '',
      '---',
      '',
    ].join('\n');

    const tinkererHeader = [
      '# KB: Tinkerer',
      '',
      '> Append-only knowledge base for the Tinkerer persona on this repo.',
      '> Newest entries on top. Each entry is dated and links the work that produced it.',
      '',
      '---',
      '',
    ].join('\n');

    writeFileSync(join(seedDir, 'KB-Global.md'), globalHeader);
    writeFileSync(join(seedDir, 'KB-Tinkerer.md'), tinkererHeader);

    await exec('git', ['-C', seedDir, 'add', '-A'], { env: GIT_SETUP_ENV });
    await exec('git', ['-C', seedDir, 'commit', '-m', 'kb: bootstrap pages'], { env: GIT_SETUP_ENV });
    // Push to the bare remote.  HEAD is used so the branch name is inferred
    // from the init default (avoids hardcoding 'master' vs 'main').
    await exec('git', ['-C', seedDir, 'push', '-u', 'origin', 'HEAD'], { env: GIT_SETUP_ENV });

    // Create the KB worktree as a regular clone of the bare repo.
    // Its origin points to bareDir, so `git push --force-with-lease` inside
    // the agentify-kb CLI will push back to bareDir.
    await exec('git', ['clone', bareDir, kbWorktreeDir], { env: GIT_SETUP_ENV });

    // Code scratch dir for FakeWorktreeManager.
    mkdirSync(codeWorkDir, { recursive: true });
  }, 30_000);

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Step 1: write ──────────────────────────────────────────────────────────

  it(
    'write: SkillRunner.run injects KB_CLONE_DIR; kbMain appends entry to KB-Tinkerer.md',
    async () => {
      const state = new AgentState({ capacity: 100 });
      state.setAgentId('agent-smoke-write');

      /**
       * Simulates Claude calling:
       *   agentify-kb append persona --from-issue 999 --file <body-file>
       *
       * KB_CLONE_DIR and AGENTIFY_PERSONA are already set in process.env by
       * SkillRunner before adapter.run() is invoked; passing process.env
       * captures them at call-time.
       *
       * The two leading argv elements ('node', 'agentify-kb') mirror how
       * process.argv is structured when the CLI runs as a subprocess;
       * main() slices them off with argv.slice(2) before parsing subcommands.
       */
      const writeAdapter: ClaudeAdapter = {
        async run(_opts: SkillRunOptions): Promise<SkillRunOutput> {
          await kbMain(
            [
              'node',
              'agentify-kb',
              'append',
              'persona',
              '--from-issue',
              String(TARGET_ID),
              '--file',
              bodyFile,
            ],
            process.env,
          );
          return {
            outcome: 'success',
            sessionId: 'sess-smoke-write',
            artifacts: {},
          };
        },
      };

      const runner = new SkillRunner({
        config: makeConfig(),
        soulRef: new SoulRef(makeSoul()),
        coordinator: new FakeCoordinator() as unknown as CoordinatorClient,
        adapter: writeAdapter,
        github: new FakeGitHub(),
        worktreeManager: new FakeWorktreeManager(codeWorkDir) as unknown as WorktreeManager,
        wikiManager: new FakeWikiManager(kbWorktreeDir) as unknown as WikiManager,
        state,
        logger: silentLog,
      });

      state.startJob({
        id: 'j_smoke_write',
        method: 'implement',
        repo: REPO,
        target_id: TARGET_ID,
        started_at: Date.now(),
      });

      // Guard: if kbMain hits an unexpected error path and calls process.exit(),
      // convert it to a thrown Error so SkillRunner catches it as sdk_failure
      // rather than killing the entire test-runner process.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(
        (code?: string | number | null) => {
          throw new Error(`process.exit(${code ?? 0})`);
        },
      );
      try {
        await runSkill(runner, 'j_smoke_write');
      } finally {
        exitSpy.mockRestore();
      }

      // --- Job-level assertion ---
      const job = state.getJob('j_smoke_write');
      expect(job?.result?.outcome, 'write run must succeed').toBe('success');

      // --- KB file assertions ---
      const kbContent = readFileSync(join(kbWorktreeDir, 'KB-Tinkerer.md'), 'utf8');

      // The synthetic marker must appear in the written entry.
      expect(kbContent, 'KB-Tinkerer.md must contain the synthetic marker').toContain(
        SYNTHETIC_MARKER,
      );
      // agentify-kb stamps entries with `## YYYY-MM-DD · <source>? · <jobId>`
      // and the body verbatim on subsequent lines.
      expect(kbContent, 'KB-Tinkerer.md must have a ## date heading').toMatch(
        /## \d{4}-\d{2}-\d{2} · /,
      );
      // The source-issue reference (#999) must appear in the heading refs.
      expect(kbContent, 'KB-Tinkerer.md must reference issue #999').toContain(
        `#${TARGET_ID}`,
      );
      // kbPersonaSignature('tinkerer') → '🔧 **The Tinkerer** · Implementation Specialist'.
      expect(kbContent, 'KB-Tinkerer.md must carry the Tinkerer signature').toContain(
        'The Tinkerer',
      );
    },
    30_000,
  );

  // ── Step 2: read ───────────────────────────────────────────────────────────

  it(
    'read: second SkillRunner.run sets KB_CLONE_DIR; adapter observes the written entry',
    async () => {
      const state = new AgentState({ capacity: 100 });
      state.setAgentId('agent-smoke-read');

      let kbCloneDirObserved: string | undefined;
      let markerObserved = false;

      /**
       * Simulates what the consult step (`cat $KB_CLONE_DIR/KB-Tinkerer.md`)
       * would observe, reading the file directly rather than shelling out.
       *
       * Asserts:
       *   (a) KB_CLONE_DIR is non-empty — SkillRunner wired it correctly.
       *   (b) Reading KB-Tinkerer.md from that path yields the entry written
       *       in the prior run — the KB lifecycle is end-to-end coherent.
       */
      const readAdapter: ClaudeAdapter = {
        async run(_opts: SkillRunOptions): Promise<SkillRunOutput> {
          kbCloneDirObserved = process.env['KB_CLONE_DIR'];
          if (kbCloneDirObserved != null) {
            const page = readFileSync(
              join(kbCloneDirObserved, 'KB-Tinkerer.md'),
              'utf8',
            );
            markerObserved = page.includes(SYNTHETIC_MARKER);
          }
          return {
            outcome: 'success',
            sessionId: 'sess-smoke-read',
            artifacts: {},
          };
        },
      };

      const runner = new SkillRunner({
        config: makeConfig(),
        soulRef: new SoulRef(makeSoul()),
        coordinator: new FakeCoordinator() as unknown as CoordinatorClient,
        adapter: readAdapter,
        github: new FakeGitHub(),
        worktreeManager: new FakeWorktreeManager(codeWorkDir) as unknown as WorktreeManager,
        wikiManager: new FakeWikiManager(kbWorktreeDir) as unknown as WikiManager,
        state,
        logger: silentLog,
      });

      state.startJob({
        id: 'j_smoke_read',
        method: 'implement',
        repo: REPO,
        target_id: TARGET_ID,
        started_at: Date.now(),
      });

      await runSkill(runner, 'j_smoke_read');

      // --- Job-level assertion ---
      const job = state.getJob('j_smoke_read');
      expect(job?.result?.outcome, 'read run must succeed').toBe('success');

      // --- KB observability assertions ---
      expect(
        kbCloneDirObserved,
        'KB_CLONE_DIR must be set in process.env when adapter.run() is called',
      ).toBe(kbWorktreeDir);

      expect(
        markerObserved,
        'consult step would observe synthetic-kb-roundtrip-marker in KB-Tinkerer.md',
      ).toBe(true);
    },
    30_000,
  );
});
