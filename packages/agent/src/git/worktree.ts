import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAppAuth } from '@octokit/auth-app';
import type { Logger } from 'pino';
import {
  PERSONA_DEFAULTS,
  isBuiltinPersona,
  normalizePrivateKey,
  parseRepo,
  type ParsedSoul,
} from '@agenti-fy/shared';
import type { Config } from '../config.js';
import type { SoulRef } from '../soul/ref.js';

const exec = promisify(execFile);

export interface PreparedWorktree {
  /** Absolute path the SDK should treat as cwd. */
  path: string;
  /** Branch name checked out in the worktree (null when running offline). */
  branch: string | null;
}

/**
 * GitHub App installation tokens are valid for 1 hour. Cache and refresh just
 * before expiry to avoid one HTTPS round-trip per worktree prepare().
 *
 * Exported so WikiManager can receive a shared instance via constructor DI,
 * removing the need for a second App auth call per dispatch.
 */
export class InstallationTokenCache {
  private value: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly auth: ReturnType<typeof createAppAuth>,
    private readonly skewMs = 60_000,
  ) {}

  async get(): Promise<string> {
    const now = Date.now();
    if (this.value && this.value.expiresAt - now > this.skewMs) return this.value.token;
    const result = (await this.auth({ type: 'installation' })) as {
      token: string;
      expiresAt?: string;
    };
    this.value = {
      token: result.token,
      expiresAt: result.expiresAt ? Date.parse(result.expiresAt) : now + 50 * 60_000,
    };
    return result.token;
  }

  /**
   * Atomically write the current token into `tokenFile` (mode 0600).
   * Writes the token with mode `0600` so other users on the host cannot read it.
   * Uses a `.tmp` sibling + rename so readers never see a half-written file.
   * Safe to call repeatedly — last writer wins with identical (or freshly
   * refreshed) content.
   */
  async ensureFile(tokenFile: string): Promise<void> {
    const token = await this.get();
    const tmp = `${tokenFile}.tmp`;
    await writeFile(tmp, token, { mode: 0o600 });
    await rename(tmp, tokenFile);
  }
}

/**
 * Builds a per-repo git credential helper command that reads the token from
 * a file. Setting this on the bare clone propagates to every linked worktree,
 * so `git fetch`, `git push`, and `git pull` issued by the Claude SDK's tool
 * subprocesses all authenticate without the token ever appearing in process
 * env or in any persisted git URL.
 *
 * Exported so WikiManager can configure the same credential helper on the
 * wiki bare clone, pointing at the same `.token` file owned by WorktreeManager.
 */
export function credentialHelperCommand(tokenFile: string): string {
  // Shell function. Single-quote everything so paths can't be misinterpreted.
  // Token never appears in argv or env — only on disk in `tokenFile` (mode 0600).
  return `!f() { printf 'username=x-access-token\\npassword=%s\\n' "$(cat '${tokenFile}')"; }; f`;
}

/**
 * How long to skip `git fetch` after a successful one. Back-to-back dispatches
 * on the same repo (multiple agents, or rapid task succession) would otherwise
 * burn the GitHub installation's secondary rate limit and add seconds of
 * wall-clock latency per prepare() on a large monorepo.
 *
 * Exported so WikiManager can share the same TTL constant without drift.
 */
export const FETCH_TTL_MS = 60_000;

/**
 * Manages per-repo bare clones and per-job worktrees.
 *
 * Layout:
 *   /workspaces/<org>/<repo>/.bare/        persistent bare clone
 *   /workspaces/<org>/<repo>/.token        installation token (0600)
 *   /workspaces/<org>/<repo>/<job_id>/     ephemeral worktree per job
 *
 * The bare clone is configured with a credential.helper that reads the token
 * file. The token never appears in any git URL or in the SDK subprocess env.
 * Refreshing the token = rewriting the file (atomic via tmp+rename).
 */
export class WorktreeManager {
  private readonly tokenCache: InstallationTokenCache | null;
  /** Last successful `git fetch` per bareDir, in process-local memory. */
  private readonly lastFetchAt = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly soulRef: SoulRef,
    private readonly logger: Logger,
  ) {
    this.tokenCache = buildTokenCache(config);
  }

  /**
   * Expose the token cache so index.ts can hand the same instance to
   * WikiManager — avoids a second GitHub App auth round-trip per dispatch.
   */
  getTokenCache(): InstallationTokenCache | null {
    return this.tokenCache;
  }

  async prepare(repo: string, job_id: string, branch?: string): Promise<PreparedWorktree> {
    const ref = parseRepo(repo);
    const repoDir = join(this.config.workspacesDir, ref.owner, ref.repo);
    const worktreePath = join(repoDir, job_id);
    await mkdir(repoDir, { recursive: true });

    if (this.config.disableGithub) {
      await mkdir(worktreePath, { recursive: true });
      this.logger.debug({ worktreePath }, 'worktree (no-github): scratch dir');
      return { path: worktreePath, branch: null };
    }

    const bareDir = join(repoDir, '.bare');
    const tokenFile = join(repoDir, '.token');
    const cloneUrl = `https://github.com/${repo}.git`;
    const helper = credentialHelperCommand(tokenFile);

    // Refresh token file (atomic write+rename, mode 0600).
    if (!this.tokenCache) throw new Error('GitHub disabled — no token available');
    await this.tokenCache.ensureFile(tokenFile);

    if (!(await pathExists(bareDir))) {
      this.logger.info({ repo, bareDir }, 'cloning bare repo');
      await runGit([
        '-c',
        `credential.helper=${helper}`,
        'clone',
        '--bare',
        cloneUrl,
        bareDir,
      ]);
      // Persist helper config on the bare so subsequent fetches and any
      // worktree pushes inherit it.
      await runGit(['-C', bareDir, 'config', 'credential.helper', helper]);
      this.lastFetchAt.set(bareDir, Date.now());
    } else {
      // Make sure no token-in-URL is left over from older versions, and
      // (re)write the credential helper config so refreshed tokens take
      // effect immediately.
      await runGit(['-C', bareDir, 'remote', 'set-url', 'origin', cloneUrl]).catch(() => {});
      await runGit(['-C', bareDir, 'config', 'credential.helper', helper]);
      // Skip `git fetch` if we fetched within FETCH_TTL_MS — back-to-back
      // dispatches on the same repo would otherwise hammer GitHub. The cost
      // of a slightly-stale checkout for a few seconds is negligible compared
      // to the latency + rate-limit pressure of fetching every dispatch.
      const lastFetch = this.lastFetchAt.get(bareDir) ?? 0;
      if (Date.now() - lastFetch >= FETCH_TTL_MS) {
        this.logger.debug({ bareDir }, 'fetching');
        await runGit(['-C', bareDir, 'fetch', '--prune', 'origin']);
        this.lastFetchAt.set(bareDir, Date.now());
      } else {
        this.logger.debug(
          { bareDir, age_ms: Date.now() - lastFetch },
          'skipping fetch (within TTL)',
        );
      }
    }

    const detected = await detectDefaultBranch(bareDir);
    // Spec calls for `feat/<agent-name>/<issue#>-<slug>` for implement work;
    // the model is responsible for renaming via `git checkout -B` once it has
    // the issue title. Our scratch branch is a safe sandbox.
    const targetBranch = branch ?? `agentify/job/${job_id}`;
    await addWorktreeFromDefault(bareDir, targetBranch, worktreePath, detected);

    const identity = gitIdentityFor(this.soulRef.current);
    await runGit(['-C', worktreePath, 'config', 'user.name', identity.name]);
    await runGit(['-C', worktreePath, 'config', 'user.email', identity.email]);

    this.logger.info(
      { repo, job_id, worktreePath, branch: targetBranch },
      'worktree ready',
    );
    return { path: worktreePath, branch: targetBranch };
  }

  /**
   * Expose the current installation token. The skill runner injects it as
   * `GH_TOKEN` into the SDK's environment so the model's `gh` invocations
   * authenticate as the App. Returns null when GitHub is disabled
   * (`DISABLE_GITHUB=true`); callers should skip `gh` setup in that case.
   */
  async getInstallationToken(): Promise<string | null> {
    if (!this.tokenCache) return null;
    return this.tokenCache.get();
  }

  async cleanup(repo: string, job_id: string): Promise<void> {
    const ref = parseRepo(repo);
    const repoDir = join(this.config.workspacesDir, ref.owner, ref.repo);
    const worktreePath = join(repoDir, job_id);

    if (this.config.disableGithub) {
      await rm(worktreePath, { recursive: true, force: true });
      return;
    }

    const bareDir = join(repoDir, '.bare');
    try {
      await runGit(['-C', bareDir, 'worktree', 'remove', '--force', worktreePath]);
    } catch (err) {
      this.logger.warn(
        { repo, job_id, err: err instanceof Error ? err.message : String(err) },
        'worktree remove failed; falling back to rm -rf',
      );
      await rm(worktreePath, { recursive: true, force: true });
      // Then prune to clear orphan worktree metadata in .bare/worktrees/.
      await runGit(['-C', bareDir, 'worktree', 'prune']).catch(() => {});
    }
  }
}

/** Exported for use by index.ts so a single cache instance is shared. */
export function buildTokenCache(config: Config): InstallationTokenCache | null {
  if (config.disableGithub) return null;
  // The schema's superRefine guarantees these are present when disableGithub
  // is false, but TS can't see through that — defensive throws if not.
  if (
    !config.githubAppId ||
    !config.githubAppPrivateKey ||
    !config.githubAppInstallationId
  ) {
    throw new Error('WorktreeManager: GitHub App credentials missing despite DISABLE_GITHUB=false');
  }
  return new InstallationTokenCache(
    createAppAuth({
      appId: config.githubAppId,
      privateKey: normalizePrivateKey(config.githubAppPrivateKey),
      installationId: config.githubAppInstallationId,
    }),
  );
}

/**
 * Derive the git user.name / user.email for a SOUL. Exported so WikiManager
 * can set the same identity on wiki worktrees without duplicating the logic.
 */
export function gitIdentityFor(soul: ParsedSoul): { name: string; email: string } {
  if (soul.frontmatter.git?.name && soul.frontmatter.git.email) {
    return { name: soul.frontmatter.git.name, email: soul.frontmatter.git.email };
  }
  if (isBuiltinPersona(soul.frontmatter.type)) {
    const def = PERSONA_DEFAULTS[soul.frontmatter.type];
    return { name: def.gitName, email: def.gitEmail };
  }
  return {
    name: soul.frontmatter.name,
    email: `${soul.frontmatter.name}@agentify.local`,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function detectDefaultBranch(bareDir: string): Promise<string | null> {
  // `git clone --bare` configures `fetch = +refs/heads/*:refs/heads/*` and
  // sets the default branch as the symbolic-ref of HEAD pointing to
  // `refs/heads/<branch>` — there is NO `refs/remotes/origin/HEAD` in a bare
  // clone. Try the bare layout first (HEAD), then fall back to the non-bare
  // layout for robustness.
  try {
    const { stdout } = await runGit(['-C', bareDir, 'symbolic-ref', 'HEAD']);
    return stdout.trim().replace(/^refs\/heads\//, '');
  } catch {
    // fall through
  }
  try {
    const { stdout } = await runGit([
      '-C',
      bareDir,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]);
    return stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  } catch {
    return null;
  }
}

/**
 * Try to `git worktree add -B <target> <path> origin/<branch>` for each
 * candidate in order. Necessary because symbolic-ref can fail (or return a
 * stale answer) on a fresh clone. Falls through to main → master so legacy
 * repos work without operator intervention.
 */
async function addWorktreeFromDefault(
  bareDir: string,
  targetBranch: string,
  worktreePath: string,
  detected: string | null,
): Promise<void> {
  const candidates: string[] = [];
  if (detected) candidates.push(detected);
  if (!candidates.includes('main')) candidates.push('main');
  if (!candidates.includes('master')) candidates.push('master');

  let lastErr: unknown;
  for (const branch of candidates) {
    // In a `--bare` clone the upstream branches live at `refs/heads/<name>`,
    // not `refs/remotes/origin/<name>`. Using the unprefixed branch lets git
    // DWIM the right ref in BOTH bare and non-bare layouts (refs/heads first,
    // then refs/remotes/origin), so this works regardless of clone style.
    try {
      await runGit([
        '-C',
        bareDir,
        'worktree',
        'add',
        '-B',
        targetBranch,
        worktreePath,
        branch,
      ]);
      return;
    } catch (err) {
      lastErr = err;
      // Try the next candidate. The previous attempt may have left a partial
      // worktree directory AND/OR orphan metadata at .bare/worktrees/<name>/.
      // Without `worktree prune`, the next add fails with "already locked" or
      // "missing but already locked worktree".
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await runGit(['-C', bareDir, 'worktree', 'prune']).catch(() => undefined);
    }
  }
  throw new Error(
    `could not check out default branch (tried: ${candidates.join(', ')}): ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/**
 * Thin wrapper around `git` that scrubs auth tokens from error messages.
 * Exported so WikiManager can route all wiki git commands through the same
 * wrapper instead of maintaining a duplicate copy.
 */
export async function runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec('git', args, {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    // Defensive: scrub any auth bits that might have leaked into stderr.
    const safe = (e.stderr ?? e.message)
      .replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic ***')
      .replace(/x-access-token:[^@\s/]+/g, 'x-access-token:***');
    // Preserve the original via cause so debug surfaces exit code/signal.
    throw new Error(`git ${args.join(' ')} failed: ${safe}`, { cause: err });
  }
}
