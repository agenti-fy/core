/**
 * WikiManager — per-repo bare wiki clones and per-job wiki worktrees.
 *
 * Mirrors WorktreeManager's layout but targets the GitHub wiki repo
 * (`https://github.com/<owner>/<repo>.wiki.git`) instead of the code repo.
 *
 * Layout:
 *   /workspaces/<org>/<repo>/.kb-bare/      persistent bare wiki clone
 *   /workspaces/<org>/<repo>/.token         shared token file (owned by WorktreeManager)
 *   /workspaces/<org>/<repo>/.kb/<job_id>/  ephemeral wiki worktree per job
 *
 * Shared helpers:
 *   - `credentialHelperCommand` from worktree.ts: points the wiki bare clone's
 *     credential.helper at the same `.token` file. WikiManager also writes the
 *     token file itself via `tokenCache.ensureFile()` at the start of `_prepare`
 *     (see below), making `prepare()` order-independent — no longer relies on
 *     WorktreeManager having run first for the same repo. Tracked: #337.
 *   - `runGit` from worktree.ts: single git wrapper with auth-token scrubbing.
 *   - `gitIdentityFor` from worktree.ts: identical git user.name/email logic.
 *   - `FETCH_TTL_MS` from worktree.ts: shared fetch-debounce constant.
 *
 * Token cache DI:
 *   `InstallationTokenCache` is passed in via the constructor (option A from
 *   the spec) — index.ts creates one shared instance and hands it to both
 *   WorktreeManager and WikiManager, avoiding a second GitHub App auth call.
 *
 * Best-effort semantics:
 *   `prepare()` and `cleanup()` catch all errors, log a warning, and return
 *   gracefully. The caller's job continues even when the KB is unavailable.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { parseRepo } from '@agentify/shared';
import type { Config } from '../config.js';
import type { SoulRef } from '../soul/ref.js';
import {
  credentialHelperCommand,
  FETCH_TTL_MS,
  gitIdentityFor,
  type InstallationTokenCache,
  runGit,
} from '../git/worktree.js';

// ── Public interface ─────────────────────────────────────────────────────────

export interface PreparedWiki {
  /**
   * Absolute path to the per-job wiki worktree. Null when KB is disabled or
   * the wiki repo is uninitialized (first-time 404 on clone).
   */
  cloneDir: string | null;
  /**
   * Absolute path to the credential token file shared with WorktreeManager.
   * Null when KB is disabled or unavailable.
   */
  tokenFile: string | null;
}

// ── WikiManager ──────────────────────────────────────────────────────────────

export class WikiManager {
  /** Last successful `git fetch` per bareDir, in process-local memory. */
  private readonly lastFetchAt = new Map<string, number>();
  /**
   * Repos for which we have already logged a one-time 404 warning. Prevents
   * log spam on every prepare() call when a wiki is permanently uninitialized.
   */
  private readonly warnedRepos = new Set<string>();

  /**
   * @param config      Agent config (reads kbEnabled, workspacesDir).
   * @param soulRef     Mutable SOUL holder — identity is read per-call.
   * @param logger      Structured logger.
   * @param tokenCache  Shared installation-token cache from WorktreeManager.
   *                    Null when DISABLE_GITHUB=true.
   */
  constructor(
    private readonly config: Config,
    private readonly soulRef: SoulRef,
    private readonly logger: Logger,
    private readonly tokenCache: InstallationTokenCache | null,
  ) {}

  /**
   * Ensure the bare wiki clone exists and is up-to-date, then add a per-job
   * linked worktree. Returns paths the caller needs; both are null when the KB
   * is unavailable so callers never need to branch on the error itself.
   */
  async prepare(repo: string, job_id: string): Promise<PreparedWiki> {
    if (!this.config.kbEnabled) {
      return { cloneDir: null, tokenFile: null };
    }

    try {
      return await this._prepare(repo, job_id);
    } catch (err) {
      this.logger.warn(
        { repo, job_id, err: err instanceof Error ? err.message : String(err) },
        'wiki prepare failed — KB will be unavailable for this job',
      );
      return { cloneDir: null, tokenFile: null };
    }
  }

  /**
   * Remove the per-job wiki worktree. Best-effort: any failure is logged but
   * never re-thrown — the caller's cleanup must complete regardless.
   */
  async cleanup(repo: string, job_id: string): Promise<void> {
    try {
      await this._cleanup(repo, job_id);
    } catch (err) {
      this.logger.warn(
        { repo, job_id, err: err instanceof Error ? err.message : String(err) },
        'wiki cleanup failed (non-fatal)',
      );
    }
  }

  /**
   * Return the current GitHub App installation token. Mirrors
   * WorktreeManager.getInstallationToken() — both share the same underlying
   * cache so only one token is live at any time.
   */
  async getInstallationToken(): Promise<string | null> {
    if (!this.tokenCache) return null;
    return this.tokenCache.get();
  }

  // ── Private implementation ─────────────────────────────────────────────────

  private async _prepare(repo: string, job_id: string): Promise<PreparedWiki> {
    const ref = parseRepo(repo);
    const repoDir = join(this.config.workspacesDir, ref.owner, ref.repo);
    const bareDir = join(repoDir, '.kb-bare');
    const tokenFile = join(repoDir, '.token');
    const kbDir = join(repoDir, '.kb');
    const worktreePath = join(kbDir, job_id);
    const wikiUrl = `https://github.com/${repo}.wiki.git`;

    // The credential helper reads the same `.token` file that WorktreeManager
    // owns and keeps fresh. Setting it on the bare clone means every linked
    // worktree and every `git push` from agentify-kb inherits it without the
    // token ever appearing in a URL or environment variable.
    const helper = credentialHelperCommand(tokenFile);

    await mkdir(repoDir, { recursive: true });

    // Defensive: WikiManager doesn't own the token file (WorktreeManager does),
    // but if a caller invokes us before worktreeManager.prepare() for this repo,
    // the credential helper would `cat` an empty/missing file and git auth would
    // fail silently into our null-return path. Writing here is a no-op when
    // WorktreeManager already wrote it (same content within the cache TTL).
    // Tracked: #337.
    if (this.tokenCache) {
      await this.tokenCache.ensureFile(tokenFile);
    }

    if (!(await pathExists(bareDir))) {
      this.logger.info({ repo, bareDir }, 'cloning wiki bare repo');
      try {
        await runGit([
          '-c', `credential.helper=${helper}`,
          'clone', '--bare', wikiUrl, bareDir,
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (is404(msg)) {
          if (!this.warnedRepos.has(repo)) {
            this.warnedRepos.add(repo);
            this.logger.warn(
              { repo },
              'wiki repo returned 404 — wiki is likely uninitialized; KB disabled for this repo until bootstrap (#252)',
            );
          }
          return { cloneDir: null, tokenFile: null };
        }
        throw err;
      }
      // Persist the credential helper on the bare so subsequent fetches and
      // worktree pushes inherit it without a -c flag on every command.
      await runGit(['-C', bareDir, 'config', 'credential.helper', helper]);
      this.lastFetchAt.set(bareDir, Date.now());
    } else {
      // Re-apply the helper in case the token path changed (e.g. workspacesDir
      // override) or a previous run left a stale entry.
      await runGit(['-C', bareDir, 'config', 'credential.helper', helper]);

      const lastFetch = this.lastFetchAt.get(bareDir) ?? 0;
      if (Date.now() - lastFetch >= FETCH_TTL_MS) {
        this.logger.debug({ bareDir }, 'fetching wiki');
        await runGit(['-C', bareDir, 'fetch', '--prune']);
        this.lastFetchAt.set(bareDir, Date.now());
      } else {
        this.logger.debug(
          { bareDir, age_ms: Date.now() - lastFetch },
          'skipping wiki fetch (within TTL)',
        );
      }
    }

    await mkdir(kbDir, { recursive: true });
    await addWikiWorktree(bareDir, worktreePath);

    // Set per-worktree git identity from the current SOUL so wiki commits are
    // attributed to the persona (same logic as code-repo worktrees).
    const identity = gitIdentityFor(this.soulRef.current);
    await runGit(['-C', worktreePath, 'config', 'user.name', identity.name]);
    await runGit(['-C', worktreePath, 'config', 'user.email', identity.email]);

    this.logger.info({ repo, job_id, worktreePath }, 'wiki worktree ready');
    return { cloneDir: worktreePath, tokenFile };
  }

  private async _cleanup(repo: string, job_id: string): Promise<void> {
    const ref = parseRepo(repo);
    const repoDir = join(this.config.workspacesDir, ref.owner, ref.repo);
    const bareDir = join(repoDir, '.kb-bare');
    const worktreePath = join(repoDir, '.kb', job_id);

    try {
      await runGit(['-C', bareDir, 'worktree', 'remove', '--force', worktreePath]);
    } catch (err) {
      this.logger.warn(
        { repo, job_id, err: err instanceof Error ? err.message : String(err) },
        'wiki worktree remove failed; falling back to rm -rf',
      );
      await rm(worktreePath, { recursive: true, force: true });
      // Prune orphaned worktree metadata in .kb-bare/worktrees/.
      await runGit(['-C', bareDir, 'worktree', 'prune']).catch(() => {});
    }
  }
}

// ── Private helpers ──────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the default branch of the wiki bare clone.
 * Wikis historically default to `master`; `main` is a secondary fallback.
 */
async function detectWikiBranch(bareDir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['-C', bareDir, 'symbolic-ref', 'HEAD']);
    const branch = stdout.trim().replace(/^refs\/heads\//, '');
    if (branch) return branch;
  } catch {
    // symbolic-ref fails on an empty repo — fall through to candidates
  }
  return null;
}

/**
 * Add a linked worktree for the wiki's default branch.
 * Tries detected → master → main in order; cleans up partial state between
 * attempts so a failed add doesn't poison the next one.
 */
async function addWikiWorktree(bareDir: string, worktreePath: string): Promise<void> {
  const detected = await detectWikiBranch(bareDir);

  const candidates: string[] = [];
  if (detected) candidates.push(detected);
  if (!candidates.includes('master')) candidates.push('master');
  if (!candidates.includes('main')) candidates.push('main');

  let lastErr: unknown;
  for (const branch of candidates) {
    try {
      await runGit(['-C', bareDir, 'worktree', 'add', worktreePath, branch]);
      return;
    } catch (err) {
      lastErr = err;
      // Clean up any partial state before trying the next candidate.
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await runGit(['-C', bareDir, 'worktree', 'prune']).catch(() => undefined);
    }
  }
  throw new Error(
    `could not check out wiki default branch (tried: ${candidates.join(', ')}): ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/**
 * Heuristic 404 detection for `git clone` failures against GitHub wiki URLs.
 * GitHub returns HTTP 404 for repos that don't exist yet (uninitialized wikis),
 * which git surfaces as "repository not found" in stderr.
 */
function is404(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return lower.includes('not found') || lower.includes('404');
}
