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
 *
 * Bootstrap (ensurePages):
 *   After a successful worktree checkout, `prepare()` calls `ensurePages()`
 *   which creates `KB-Global.md` and `KB-<Persona>.md` if absent, then
 *   commits and pushes them. Push retries once on non-fast-forward; any
 *   remaining failure is logged and the worktree stays usable for the job.
 *
 * Uninitialized wiki caching:
 *   When `git clone` returns exit code 128 + "not found" the repo is added
 *   to an in-memory `uninitializedRepos` set. Subsequent `prepare()` calls
 *   for the same repo skip the clone attempt entirely (no log spam, no
 *   latency) and return `{ cloneDir: null, tokenFile: null }`.
 */

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { parseRepo, type ParsedSoul } from '@agenti-fy/shared';
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

// ── Public utilities ─────────────────────────────────────────────────────────

/**
 * Pascal-case a hyphen-/underscore-/lower-separated identifier.
 *
 * Examples:
 *   `tinkerer`  → `Tinkerer`
 *   `my-custom` → `My-Custom`
 *   `my_agent`  → `My-Agent`
 *
 * Internal helper — callers should use `kbPersonaTitle` /
 * `kbPersonaPageFilename` for SOUL-aware casing.
 */
function toPascalCase(s: string): string {
  return s
    .split(/[-_]/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ''))
    .join('-');
}

/**
 * Derive the Pascal-cased persona title used in KB page names.
 *
 * - Built-in souls use `frontmatter.type`  (`tinkerer` → `Tinkerer`).
 * - Custom souls   use `frontmatter.name`  (`my-bot`   → `My-Bot`).
 *
 * Exported so `agentify-kb` CLI can compute the persona page filename
 * without duplicating the casing logic.
 */
export function kbPersonaTitle(soul: ParsedSoul): string {
  const key =
    soul.frontmatter.type === 'custom' ? soul.frontmatter.name : soul.frontmatter.type;
  return toPascalCase(key);
}

/**
 * Compute the persona-scoped KB page filename for a SOUL.
 *
 * Example (default prefix `KB-`): Tinkerer soul → `KB-Tinkerer.md`
 *
 * Exported so `agentify-kb` CLI can reuse the mapping logic.
 */
export function kbPersonaPageFilename(soul: ParsedSoul, kbPagePrefix: string): string {
  return `${kbPagePrefix}${kbPersonaTitle(soul)}.md`;
}

// ── WikiManager ──────────────────────────────────────────────────────────────

export class WikiManager {
  /** Last successful `git fetch` per bareDir, in process-local memory. */
  private readonly lastFetchAt = new Map<string, number>();
  /**
   * Repos for which we have already logged a one-time "not initialized" warning.
   * Prevents log spam on every prepare() call when a wiki is permanently uninitialized.
   */
  private readonly warnedRepos = new Set<string>();
  /**
   * Repos whose wiki repo is known to be uninitialized (git clone returned
   * exit code 128 + "not found" at least once this process lifetime). Cached
   * so subsequent prepare() calls skip the clone attempt entirely.
   */
  private readonly uninitializedRepos = new Set<string>();

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
    // Fast-path: skip the clone attempt for repos whose wiki is known to be
    // uninitialized. Avoids repeated network round-trips and log spam.
    if (this.uninitializedRepos.has(repo)) {
      return { cloneDir: null, tokenFile: null };
    }

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
        if (isWikiUninitialized(err)) {
          // Cache the verdict so future calls skip the clone attempt.
          this.uninitializedRepos.add(repo);
          if (!this.warnedRepos.has(repo)) {
            this.warnedRepos.add(repo);
            this.logger.warn(
              { repo },
              `wiki not initialized for ${repo}; create the first page via the GitHub UI to enable KB`,
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

    // Ensure KB-Global.md and KB-<Persona>.md exist. Creates them from a
    // seed header if absent, then commits + pushes. Idempotent on subsequent
    // calls. Errors here are non-fatal — the worktree remains usable.
    await this.ensurePages(worktreePath, this.soulRef.current);

    this.logger.info({ repo, job_id, worktreePath }, 'wiki worktree ready');
    return { cloneDir: worktreePath, tokenFile };
  }

  /**
   * Ensure `KB-Global.md` and `KB-<Persona>.md` exist in the worktree.
   *
   * Creates any missing file with its seed header, then runs a single
   * `git add + commit + push`. Push retries once on non-fast-forward via
   * `git pull --rebase`; any failure beyond that is logged as a warning
   * and the worktree remains usable for the job — agentify-kb writes will
   * reconcile on the next run.
   *
   * Idempotent: if both files already exist the method returns without any
   * git operations.
   */
  private async ensurePages(cloneDir: string, soul: ParsedSoul): Promise<void> {
    const globalFilename = `${this.config.kbGlobalPage}.md`;
    const personaTitle = kbPersonaTitle(soul);
    const personaFilename = `${this.config.kbPagePrefix}${personaTitle}.md`;

    const created: string[] = [];

    const globalPath = join(cloneDir, globalFilename);
    if (!(await pathExists(globalPath))) {
      await writeFile(globalPath, kbPageHeader('Global', true), 'utf8');
      created.push(globalFilename);
    }

    const personaPath = join(cloneDir, personaFilename);
    if (!(await pathExists(personaPath))) {
      await writeFile(personaPath, kbPageHeader(personaTitle, false), 'utf8');
      created.push(personaFilename);
    }

    if (created.length === 0) return; // all pages exist — idempotent

    this.logger.debug({ cloneDir, pages: created }, 'kb: bootstrapping missing pages');

    await runGit(['-C', cloneDir, 'add', ...created]);
    await runGit(['-C', cloneDir, 'commit', '-m', 'kb: bootstrap pages']);

    // Resolve the current branch name once — `git clone --bare` doesn't set
    // `branch.<name>.remote` tracking config, so plain `git push` and
    // `git pull --rebase` fail with "no upstream branch" / "no tracking
    // information." Always specify `origin <branch>` explicitly. Real failure
    // mode observed: every agent's bootstrap commit sat unpushed because the
    // initial `git push` errored out in a way `agentify-kb append` couldn't
    // recover from either.
    const { stdout: branchOut } = await runGit(['-C', cloneDir, 'symbolic-ref', '--short', 'HEAD']);
    const branch = branchOut.trim();

    // Push with a single retry on non-fast-forward.
    try {
      await runGit(['-C', cloneDir, 'push', 'origin', `HEAD:${branch}`]);
    } catch (pushErr) {
      const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      if (isNonFastForward(pushMsg)) {
        this.logger.debug(
          { cloneDir },
          'kb push rejected (non-fast-forward); rebasing and retrying',
        );
        try {
          await runGit(['-C', cloneDir, 'pull', '--rebase', 'origin', branch]);
          await runGit(['-C', cloneDir, 'push', 'origin', `HEAD:${branch}`]);
        } catch (retryErr) {
          this.logger.warn(
            {
              cloneDir,
              err: retryErr instanceof Error ? retryErr.message : String(retryErr),
            },
            'kb push failed after rebase retry — bootstrap pages committed locally; agentify-kb writes will reconcile',
          );
        }
      } else {
        this.logger.warn(
          { cloneDir, err: pushMsg },
          'kb push failed — bootstrap pages committed locally; agentify-kb writes will reconcile',
        );
      }
    }
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
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the seed header for a KB page.
 *
 * Global page:  `isGlobal=true`  → description mentions "shared across all personas"
 * Persona page: `isGlobal=false` → description mentions the persona by title
 */
function kbPageHeader(title: string, isGlobal: boolean): string {
  const description = isGlobal
    ? 'global knowledge base for this repo, shared across all personas'
    : `knowledge base for the ${title} persona on this repo`;
  return [
    `# KB: ${title}`,
    '',
    `> Append-only ${description}.`,
    '> Newest entries on top. Each entry is dated and links the work that produced it.',
    '',
    '---',
    '',
  ].join('\n');
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
 * Detect that `git clone` failed because the wiki repo does not exist yet
 * (i.e. the wiki is uninitialized on GitHub).
 *
 * Requires **both** conditions to hold so transient network errors that
 * happen to mention "not found" are not misclassified:
 *
 *   1. Exit code is 128 — the code git returns for "fatal: repository not found".
 *   2. Error message contains "Repository not found" OR "not found" (broad
 *      fallback for GitHub's varied wording across API versions).
 *
 * The error thrown by `runGit` wraps the original `execFile` error as `cause`,
 * so the exit code lives at `err.cause.code`.
 */
function isWikiUninitialized(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const hasNotFound = msg.includes('repository not found') || msg.includes('not found');
  if (!hasNotFound) return false;
  // runGit wraps the original execFile error as `cause`; child process exit
  // codes are stored as numeric `.code` on that error object.
  const cause = (err as Error & { cause?: unknown }).cause;
  const code =
    cause != null && typeof cause === 'object'
      ? (cause as Record<string, unknown>).code
      : undefined;
  return code === 128;
}

/**
 * Detect a non-fast-forward push rejection (concurrent write to the same wiki
 * branch). Used to decide whether to retry with `git pull --rebase`.
 */
function isNonFastForward(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return lower.includes('non-fast-forward') || lower.includes('[rejected]');
}
