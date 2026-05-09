/**
 * install-existing.ts — `agentify-setup install --repo <owner/name>` driver.
 *
 * Given an existing `.env` produced by a prior wizard run, install the same
 * nine GitHub Apps onto an additional repository. Operator clicks through
 * GitHub's "configure repository access" page once per App; this driver
 * polls until each App can see the new repo, then prints a summary.
 *
 * What this driver assumes:
 *  - `.env` already contains valid `<PERSONA>_GITHUB_APP_ID`,
 *    `<PERSONA>_GITHUB_APP_PRIVATE_KEY`, and `<PERSONA>_GITHUB_APP_INSTALLATION_ID`
 *    for every built-in persona (the wizard's normal output).
 *  - The same `installation_id`s extend to cover the new repo. This matches
 *    GitHub's "single installation, multiple repos" model — no new IDs are
 *    minted, the existing `.env` stays valid, and the operator's coordinator
 *    can poll the new repo without any other config change.
 *  - The operator owns the Apps (i.e. is logged into the account that
 *    registered them). The settings URLs we open assume that.
 *
 * What this driver does NOT do:
 *  - Modify the operator's `.env` (no new secrets to write — the existing
 *    installation IDs cover the new repo).
 *  - Verify the coordinator/agent runtime can dispatch to the new repo.
 *    That's `agentify-setup verify` territory.
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { BUILTIN_PERSONAS, type BuiltinPersona } from '@agenti-fy/shared';
import { parseDotenv } from '../dotenv.js';
import { openInBrowser as defaultOpenInBrowser } from '../open.js';
import {
  awaitRepoInstallation,
  InstallationTimeoutError,
  type RepoRef,
} from '../install.js';
import {
  printSection,
  printOk,
  printWarn,
  printErr,
  type IoStreams,
} from '../prompts.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface InstallExistingDeps {
  /** I/O streams. */
  io: IoStreams;
  /** Path to the `.env` file produced by a prior wizard run. */
  envPath: string;
  /** Target repo (the new one to install onto). */
  repo: RepoRef;
  // ── Injectable for tests ────────────────────────────────────────────────────
  /** Override file reader. Default: `fs.readFile(p, 'utf8')`. */
  readFile?: (p: string) => Promise<string>;
  /** Override Octokit factory. Default: a real Octokit auth'd as the App. */
  octokitFactory?: (appId: number, privateKey: string) => Octokit;
  /** Override the browser-open helper. Default: production `open.ts` impl. */
  openInBrowser?: (url: string) => Promise<void>;
  /** Override the polling helper. Default: `awaitRepoInstallation` from `install.ts`. */
  awaitFn?: typeof awaitRepoInstallation;
  /** Per-poll wait time. Default: 3000ms. */
  intervalMs?: number;
  /** Total deadline per persona. Default: 600000ms (10 min). */
  timeoutMs?: number;
}

export interface PersonaCreds {
  appId: number;
  privateKey: string;
  installationId: number;
  /** GitHub bot login from `<PERSONA>_GITHUB_USER`, e.g. `agenti-fy-orchestrator[bot]`. */
  githubUser: string;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class EnvParseError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Cannot read App credentials from .env — the following keys are missing or empty:\n` +
        missing.map((k) => `  • ${k}`).join('\n') +
        `\nRun \`agentify-setup init\` first to generate a complete .env, or pass --env-in <path>.`,
    );
    this.name = 'EnvParseError';
    this.missing = missing;
  }
}

// ── .env parser ──────────────────────────────────────────────────────────────

/**
 * Extract per-persona App credentials from a parsed `.env` map.
 *
 * Throws {@link EnvParseError} listing every missing key, so the operator
 * can diagnose in one go rather than chasing them one at a time.
 */
export function parsePersonaCreds(
  env: Record<string, string>,
): Readonly<Record<BuiltinPersona, PersonaCreds>> {
  const missing: string[] = [];
  const out: Partial<Record<BuiltinPersona, PersonaCreds>> = {};

  for (const persona of BUILTIN_PERSONAS) {
    const upper = persona.toUpperCase();
    const appIdRaw = env[`${upper}_GITHUB_APP_ID`];
    const installRaw = env[`${upper}_GITHUB_APP_INSTALLATION_ID`];
    const pem = env[`${upper}_GITHUB_APP_PRIVATE_KEY`];
    const githubUser = env[`${upper}_GITHUB_USER`];

    if (!appIdRaw) missing.push(`${upper}_GITHUB_APP_ID`);
    if (!installRaw) missing.push(`${upper}_GITHUB_APP_INSTALLATION_ID`);
    if (!pem) missing.push(`${upper}_GITHUB_APP_PRIVATE_KEY`);
    if (!githubUser) missing.push(`${upper}_GITHUB_USER`);

    if (appIdRaw && installRaw && pem && githubUser) {
      const appId = Number(appIdRaw);
      const installationId = Number(installRaw);
      if (!Number.isFinite(appId) || appId <= 0) {
        missing.push(`${upper}_GITHUB_APP_ID (not a positive integer)`);
      } else if (!Number.isFinite(installationId) || installationId <= 0) {
        missing.push(`${upper}_GITHUB_APP_INSTALLATION_ID (not a positive integer)`);
      } else {
        out[persona] = { appId, privateKey: pem, installationId, githubUser };
      }
    }
  }

  if (missing.length > 0) throw new EnvParseError(missing);
  return Object.freeze(out as Record<BuiltinPersona, PersonaCreds>);
}

/**
 * Derive the App's slug from the bot login. GitHub Apps' bot users follow
 * `<slug>[bot]` — a documented invariant of the App-manifest flow.
 */
export function appSlugFromGithubUser(githubUser: string): string {
  // Strip the trailing `[bot]` if present; otherwise return as-is. We don't
  // validate further — the caller using the slug to build a URL will surface
  // any malformed input as a 404 when the operator clicks through.
  return githubUser.replace(/\[bot\]$/, '');
}

// ── Driver ───────────────────────────────────────────────────────────────────

/**
 * Run the install-existing flow:
 *   1. Read .env, parse per-persona credentials.
 *   2. For each persona, open the App's settings URL (operator clicks through
 *      to add the new repo to the installation's repo-access list).
 *   3. Poll `GET /repos/{owner}/{repo}/installation` (App-JWT-auth) until the
 *      App can see the new repo. Per-persona deadline.
 *   4. Print a summary table; return 0 on full success, 1 if any persona
 *      timed out.
 */
export async function runInstallExisting(deps: InstallExistingDeps): Promise<number> {
  const { io, repo } = deps;
  const readFileFn = deps.readFile ?? (async (p) => {
    const fs = await import('node:fs/promises');
    return fs.readFile(p, 'utf8');
  });
  const octokitFactoryFn = deps.octokitFactory ?? defaultOctokitFactory;
  const openFn = deps.openInBrowser ?? ((url) => defaultOpenInBrowser(url).then(() => void 0));
  const awaitFn = deps.awaitFn ?? awaitRepoInstallation;
  const intervalMs = deps.intervalMs ?? 3_000;
  const timeoutMs = deps.timeoutMs ?? 600_000;

  // ── Step 1: read + parse .env ─────────────────────────────────────────────
  printSection(`Reading App credentials from ${deps.envPath}`, io);
  let envContent: string;
  try {
    envContent = await readFileFn(deps.envPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printErr(`Cannot read ${deps.envPath}: ${msg}`, io);
    return 1;
  }
  const env = parseDotenv(envContent);
  const credsByPersona = parsePersonaCreds(env);
  printOk(`Parsed credentials for ${Object.keys(credsByPersona).length} personas`, io);

  // ── Step 2: open settings URL per App ─────────────────────────────────────
  printSection(`Opening configure-installation URLs for ${repo.owner}/${repo.name}`, io);
  io.stdout.write(
    `  For each App, GitHub will show the installation's "Repository access"\n` +
      `  page. Pick "All repositories" or add ${repo.owner}/${repo.name} to the\n` +
      `  selected list, then click Save. The wizard polls each App until it can\n` +
      `  see the new repo.\n\n`,
  );

  for (const persona of BUILTIN_PERSONAS) {
    const creds = credsByPersona[persona];
    const slug = appSlugFromGithubUser(creds.githubUser);
    // Direct deep-link to the installation's permissions/repository-access
    // page. Works for personally-owned Apps; GitHub redirects org-owned
    // Apps to /organizations/<org>/settings/... automatically.
    const url = `https://github.com/settings/installations/${creds.installationId}`;
    io.stdout.write(`  • ${persona.padEnd(13)} (slug: ${slug}) → ${url}\n`);
    try {
      await openFn(url);
    } catch (err) {
      // openInBrowser is best-effort — the URL was already printed above so
      // the operator can copy/paste. Don't fail the run.
      printWarn(
        `Could not auto-open browser for ${persona}: ${err instanceof Error ? err.message : String(err)}`,
        io,
      );
    }
  }

  // ── Step 3: poll for installation visibility on the new repo ──────────────
  printSection(`Waiting for each App to see ${repo.owner}/${repo.name}`, io);
  const results: Array<{ persona: BuiltinPersona; ok: boolean; detail: string }> = [];

  for (const persona of BUILTIN_PERSONAS) {
    const creds = credsByPersona[persona];
    const octokit = octokitFactoryFn(creds.appId, creds.privateKey);
    // Wrap creds + slug into the ExchangedApp shape the polling helper
    // expects. installationId / clientId / clientSecret aren't read by the
    // polling path; only `id` and `pem` matter for the JWT.
    const appShim = {
      id: creds.appId,
      slug: appSlugFromGithubUser(creds.githubUser),
      name: '',
      htmlUrl: '',
      pem: creds.privateKey,
      clientId: '',
      clientSecret: '',
      webhookSecret: null,
      ownerLogin: '',
    } as const;

    try {
      const { installationId } = await awaitFn(appShim, repo, { intervalMs, timeoutMs }, octokit);
      printOk(`${persona} can see ${repo.owner}/${repo.name} (installation ${installationId})`, io);
      results.push({ persona, ok: true, detail: `installation ${installationId}` });
    } catch (err) {
      if (err instanceof InstallationTimeoutError) {
        printErr(
          `${persona}: timed out waiting for installation. Open the URL above, ` +
            `add ${repo.owner}/${repo.name} to "Repository access", and re-run.`,
          io,
        );
        results.push({ persona, ok: false, detail: 'timeout' });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        printErr(`${persona}: ${msg}`, io);
        results.push({ persona, ok: false, detail: msg });
      }
    }
  }

  // ── Step 4: summary ───────────────────────────────────────────────────────
  printSection('Summary', io);
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    printOk(
      `All ${results.length} Apps now cover ${repo.owner}/${repo.name}. Add the repo to ` +
        `your coordinator (POST /repos http://<coordinator>:8080/repos) to start dispatching.`,
      io,
    );
    return 0;
  }
  printErr(
    `${failed.length} of ${results.length} Apps did NOT pick up the new repo: ` +
      failed.map((r) => r.persona).join(', '),
    io,
  );
  io.stdout.write(
    `\nRetry by re-running \`agentify-setup install --repo ${repo.owner}/${repo.name}\` after ` +
      `clicking through the configure URL for each missing persona.\n`,
  );
  return 1;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function defaultOctokitFactory(appId: number, privateKey: string): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
  });
}
