/**
 * preamble.ts — first wizard phase: gh auth check, prefix + repo validation,
 * and owner-type resolution.
 *
 * Exported surface
 * ----------------
 * {@link runPreamble}  – main entry; call at the top of every wizard run.
 * {@link GhExec}       – injectable gh-CLI wrapper type (for testing).
 * {@link PreambleResult} – shape of what runPreamble returns.
 * {@link PreambleOpts}  – options bag accepted by runPreamble.
 *
 * Injection points
 * ----------------
 * All I/O and shell invocations are injectable so unit tests can drive the
 * entire function without a real TTY or gh binary.  Production callers can
 * omit both (the defaults wire up process.stdin/stdout and spawnSync('gh')).
 */

import { spawnSync } from 'node:child_process';
import {
  ask,
  askYesNo,
  askChoice,
  printOk,
  printWarn,
  printSection,
  type IoStreams,
} from '../prompts.js';
import type { WizardState } from '../state.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around a `gh` invocation.  Receives the argv slice that follows
 * the `gh` binary name and returns the process exit status plus captured
 * stdio.  Null status means the process was killed by a signal.
 *
 * The default implementation uses `child_process.spawnSync`; tests substitute
 * a stub that returns canned `{ status, stdout, stderr }` objects.
 */
export type GhExec = (args: string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

/** Repository information resolved during the preamble phase. */
export interface RepoInfo {
  owner: string;
  name: string;
  /** Numeric GitHub database ID for the owner (used to pre-select on install pages). */
  ownerId?: number;
  /** Numeric GitHub database ID for the repo itself. */
  repoId?: number;
}

/** The values confirmed / collected by {@link runPreamble}. */
export interface PreambleResult {
  prefix: string;
  repo: RepoInfo;
  ownerType: 'personal' | 'organization';
}

/** Options accepted by {@link runPreamble}. */
export interface PreambleOpts {
  /**
   * Previously-saved wizard state, or `null` when starting fresh.
   *
   * When non-null the preamble offers to keep the existing prefix and repo
   * rather than re-prompting for them from scratch.
   */
  state: WizardState | null;
  /**
   * Injectable I/O streams.  Defaults to `process.stdin` / `process.stdout`.
   * Tests pass a `PassThrough` pair.
   */
  io?: IoStreams;
  /**
   * Injectable gh-CLI executor.  Defaults to `spawnSync('gh', args, ...)`.
   * Tests pass a stub that returns canned results without spawning a process.
   */
  spawn?: GhExec;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Valid App-name prefix pattern.
 *
 * Rules:
 *  - Starts with an ASCII lowercase letter or digit (`[a-z0-9]`).
 *  - Followed by 0-20 more lowercase alphanumeric / hyphen chars.
 *  - Total length: 1-21 characters.
 *
 * The longest persona name is "orchestrator" (12 chars).  With a separator
 * hyphen, `<prefix>-orchestrator` stays ≤ 34 chars at prefix length 21.
 */
export const PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,20}$/;

// ── Default GhExec ────────────────────────────────────────────────────────────

const defaultSpawn: GhExec = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: 'pipe' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Prompt for a new prefix, re-prompting on validation failure.
 * The validator enforces {@link PREFIX_RE}.
 */
async function askPrefix(io: IoStreams, defaultValue?: string): Promise<string> {
  const validate = (s: string): string | null => {
    if (!PREFIX_RE.test(s)) {
      return (
        `Invalid prefix "${s}". ` +
        `Must match ^[a-z0-9][a-z0-9-]{0,20}$ (1-21 chars, lowercase alphanumeric + hyphens).`
      );
    }
    return null;
  };
  // exactOptionalPropertyTypes: only include `default` when defined
  return defaultValue !== undefined
    ? ask('App-name prefix (e.g. "myorg")', { default: defaultValue, validate }, io)
    : ask('App-name prefix (e.g. "myorg")', { validate }, io);
}

/**
 * Prompt for a repo in `owner/name` format.
 */
async function askRepoInput(io: IoStreams): Promise<string> {
  const validate = (s: string): string | null => {
    const parts = s.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return `Invalid repo format "${s}". Expected "owner/name" (e.g. "acme/my-project").`;
    }
    return null;
  };
  return ask('Target repo (owner/name)', { validate }, io);
}

/**
 * Validate that a repo exists and is accessible by calling
 * `gh repo view <owner/name> --json name,owner`.
 *
 * Returns the resolved {@link RepoInfo} on success; throws a descriptive
 * {@link Error} when the repo is not found or not accessible.
 */
function validateRepoWithGh(repoSlug: string, spawn: GhExec): RepoInfo {
  const result = spawn(['repo', 'view', repoSlug, '--json', 'name,owner']);
  if (result.status !== 0) {
    const diag = result.stderr.trim();
    throw new Error(
      `Repository "${repoSlug}" was not found or is not accessible.` +
        (diag ? `\nDiagnostics: ${diag}` : ''),
    );
  }

  let parsed: { name?: string; owner?: { login?: string; id?: number } };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    throw new Error(
      `Failed to parse "gh repo view" output for "${repoSlug}". ` +
        `Unexpected response: ${result.stdout.slice(0, 200)}`,
    );
  }

  const ownerLogin = parsed.owner?.login;
  const repoName = parsed.name;

  if (!ownerLogin || !repoName) {
    throw new Error(
      `Unexpected "gh repo view" response for "${repoSlug}": missing name or owner.login.`,
    );
  }

  // exactOptionalPropertyTypes: only include ownerId when it is a real number
  const info: RepoInfo = { owner: ownerLogin, name: repoName };
  const rawId = parsed.owner?.id;
  if (typeof rawId === 'number') info.ownerId = rawId;
  return info;
}

/**
 * Attempt to infer the owner type (personal user vs. organization) by calling
 * `gh api /users/<owner>`, which returns `{ type: "User" | "Organization" }`.
 *
 * Returns `null` when the inference fails (network error, unexpected JSON,
 * unknown type string) so the caller can fall back to asking the user.
 */
function inferOwnerType(
  owner: string,
  spawn: GhExec,
): 'personal' | 'organization' | null {
  const result = spawn(['api', `/users/${owner}`]);
  if (result.status !== 0) return null;

  let data: { type?: unknown };
  try {
    data = JSON.parse(result.stdout) as typeof data;
  } catch {
    return null;
  }

  if (data.type === 'Organization') return 'organization';
  if (data.type === 'User') return 'personal';
  return null;
}

/**
 * Ask the user to choose between personal user account and organization.
 */
async function askOwnerType(
  io: IoStreams,
  defaultValue?: 'personal' | 'organization',
): Promise<'personal' | 'organization'> {
  // exactOptionalPropertyTypes: only include `default` when defined
  const opts = defaultValue !== undefined
    ? { default: defaultValue }
    : {};
  return askChoice<'personal' | 'organization'>(
    'Owner type:',
    [
      { value: 'personal', label: 'Personal user account' },
      { value: 'organization', label: 'Organization' },
    ],
    opts,
    io,
  );
}

// ── runPreamble ───────────────────────────────────────────────────────────────

/**
 * Run the wizard preamble phase.
 *
 * Execution order:
 *  1. Verify `gh` is on PATH and the user is authenticated (`gh auth status`).
 *  2. Prompt for (or confirm) the App-name **prefix**; validate against
 *     {@link PREFIX_RE}.
 *  3. Prompt for (or confirm) the target **repo**; validate via
 *     `gh repo view <owner/name> --json name,owner`.
 *  4. Determine the repo **owner type** — first by calling `gh api /users/<owner>`;
 *     fall back to asking the user when the inference fails.
 *
 * When `opts.state` is non-null the function offers to retain the existing
 * `prefix` and `repo` values rather than re-prompting from scratch, reducing
 * friction on re-runs.
 *
 * @throws {Error}           When `gh` is absent or not authenticated.
 * @throws {PromptCancelled} When the user aborts a prompt (EOF / Ctrl-C).
 */
export async function runPreamble(opts: PreambleOpts): Promise<PreambleResult> {
  const io: IoStreams = opts.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
  };
  const spawn = opts.spawn ?? defaultSpawn;
  const { state } = opts;

  // ── Step 1: gh auth check ─────────────────────────────────────────────────

  printSection('GitHub CLI check', io);

  const authResult = spawn(['auth', 'status']);
  if (authResult.status !== 0) {
    const diag = authResult.stderr.trim();
    throw new Error(
      `gh CLI is not authenticated. Run "gh auth login" first.` +
        (diag ? `\nDiagnostics: ${diag}` : ''),
    );
  }

  // gh outputs auth info to stderr; extract the login if present.
  const loginMatch = /Logged in to github\.com account (\S+)/.exec(authResult.stderr);
  const login = loginMatch?.[1] ?? 'unknown';
  printOk(`gh CLI authenticated (user: ${login})`, io);

  // ── Step 2: prefix ────────────────────────────────────────────────────────

  printSection('App-name prefix', io);

  let prefix: string;
  if (state?.prefix) {
    const keep = await askYesNo(
      `Keep existing prefix "${state.prefix}"?`,
      { default: true },
      io,
    );
    prefix = keep ? state.prefix : await askPrefix(io);
  } else {
    prefix = await askPrefix(io);
  }

  // ── Step 3: target repo ───────────────────────────────────────────────────

  printSection('Target repository', io);

  let repo: RepoInfo;
  let keptExistingRepo = false;

  if (state?.repo) {
    const existing = `${state.repo.owner}/${state.repo.name}`;
    const keep = await askYesNo(`Keep existing repo "${existing}"?`, { default: true }, io);
    if (keep) {
      // Convert state.repo → RepoInfo: Zod optional fields are typed as `T | undefined`
      // (present-but-undefined), while exactOptionalPropertyTypes requires absent-or-T.
      const stateRepo = state.repo;
      repo = { owner: stateRepo.owner, name: stateRepo.name };
      if (typeof stateRepo.ownerId === 'number') repo.ownerId = stateRepo.ownerId;
      if (typeof stateRepo.repoId === 'number') repo.repoId = stateRepo.repoId;
      keptExistingRepo = true;
    } else {
      const input = await askRepoInput(io);
      repo = validateRepoWithGh(input, spawn);
      printOk(`Repository "${repo.owner}/${repo.name}" found.`, io);
    }
  } else {
    const input = await askRepoInput(io);
    repo = validateRepoWithGh(input, spawn);
    printOk(`Repository "${repo.owner}/${repo.name}" found.`, io);
  }

  // ── Step 4: owner type ────────────────────────────────────────────────────

  printSection('Owner type', io);

  let ownerType: 'personal' | 'organization';

  // When the user kept an existing repo and we have a saved ownerType,
  // use that (no need to re-infer or re-ask).
  if (keptExistingRepo && state?.ownerType) {
    ownerType = state.ownerType;
    printOk(`Owner type: ${ownerType} (from saved state)`, io);
  } else {
    const inferred = inferOwnerType(repo.owner, spawn);
    if (inferred !== null) {
      ownerType = inferred;
      printOk(
        `Owner type inferred as "${ownerType}" from GitHub API.`,
        io,
      );
    } else {
      printWarn(
        'Could not infer owner type from GitHub API. Please select manually.',
        io,
      );
      ownerType = await askOwnerType(io, state?.ownerType ?? undefined);
    }
  }

  return { prefix, repo, ownerType };
}
