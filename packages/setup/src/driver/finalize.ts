/**
 * finalize.ts — write `.env` + `verify` subcommand driver.
 *
 * Exported surface
 * ----------------
 * {@link runFinalize}   – write the rendered `.env` to disk (or stdout in dry-run).
 * {@link runVerify}     – re-check an already-written `.env` without re-running
 *                         the wizard; called by the `verify` subcommand.
 * {@link FinalizeDeps}  – injectable dependencies for runFinalize (testing).
 * {@link VerifyDeps}    – injectable dependencies for runVerify (testing).
 *
 * Design notes
 * ------------
 * Both functions do NOT import from `index.ts` (which imports this file) to
 * avoid a circular dependency cycle.  The {@link FinalizeDeps} shape is
 * structurally identical to `PhaseOpts & { optional extras }`, so
 * `runFinalize` is assignable to `PhaseFn` when the optional fields are omitted.
 *
 * The dotenv parser lives in `../dotenv.ts` (promoted from the inline copy in
 * `env-renderer.test.ts`) so both the write path (for verification in tests)
 * and the verify subcommand share the same implementation.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { BUILTIN_PERSONAS } from '@agenti-fy/shared';
import { parseDotenv } from '../dotenv.js';
import { renderEnv, type WizardConfig } from '../env-renderer.js';
import { renderCompose } from '../compose.js';
import { loadBundledSouls as defaultLoadBundledSouls } from '../souls.js';
import {
  askChoice,
  printSection,
  printOk,
  printErr,
  printWarn,
  type IoStreams,
} from '../prompts.js';
import type { WizardState, PersonaCreds } from '../state.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Dependency-injection bag for {@link runFinalize}.
 *
 * Mirrors the `PhaseOpts` shape plus optional extras for dry-run / path
 * override, and injectable filesystem operations for hermetic unit tests.
 *
 * Note: this interface does NOT import from `index.ts` (circular prevention).
 * TypeScript structural typing ensures it remains assignable to `PhaseFn` when
 * `dryRun` and `envOut` are omitted.
 */
export interface FinalizeDeps {
  /** Current wizard state (all phases completed). */
  state: WizardState;
  /** Injectable I/O streams.  Defaults to process.stdin/stdout in production. */
  io: IoStreams;
  /** When true, print the rendered `.env` to stdout instead of writing to disk. */
  dryRun?: boolean;
  /** Override the output path.  Defaults to `<cwd>/.env`. */
  envOut?: string;
  /**
   * When true, skip writing `docker-compose.yml` and `souls/<persona>.md`.
   * Default false — the wizard writes both alongside the `.env` so an
   * operator who never cloned the source repo still has everything they
   * need to run `docker compose up`.
   */
  noCompose?: boolean;
  /**
   * Override the docker-compose.yml output path. Defaults to
   * `<dirname-of-envPath>/docker-compose.yml`.
   */
  composeOut?: string;
  /**
   * Image tag to pin in the generated docker-compose.yml. Defaults to the
   * caller's wizard version (the orchestrator passes `VERSION` from bin.ts).
   * Operator override via `--image-tag` on the CLI.
   */
  imageTag?: string;
  /**
   * Image registry (without trailing slash, without package name) for the
   * generated compose. Defaults to `ghcr.io/agenti-fy`.
   */
  imageRegistry?: string;
  // ── Injections for hermetic testing ────────────────────────────────────────
  /** Override `process.cwd()`. */
  cwd?: () => string;
  /** Override filesystem existence check. */
  fileExists?: (p: string) => Promise<boolean>;
  /** Override atomic file write.  Receives the final path, content, and mode. */
  writeEnvFile?: (p: string, content: string) => Promise<void>;
  /**
   * Override the bundled-souls loader. Default reads from `dist/souls/` next
   * to the compiled finalize module. Tests inject a fixture so they don't
   * have to copy real soul files into the test fixture directory.
   */
  loadBundledSouls?: () => Promise<Readonly<Record<string, string>>>;
}

/**
 * Dependency-injection bag for {@link runVerify}.
 *
 * Every field except `io` is optional; omitting overrides uses the production
 * defaults.  Tests substitute stubs to run without real filesystems or network.
 */
export interface VerifyDeps {
  /** Injectable I/O streams.  Defaults to process.stdin/stdout in production. */
  io: IoStreams;
  /** Path to the `.env` file to verify.  Defaults to `<cwd>/.env`. */
  envPath?: string;
  // ── Injections for hermetic testing ────────────────────────────────────────
  /** Override `process.cwd()`. */
  cwd?: () => string;
  /** Override file read (must return the raw .env content). */
  readEnvFile?: (p: string) => Promise<string>;
  /**
   * Override Octokit factory.  Receives `appId` and `privateKey` (PEM string)
   * and must return an Octokit instance authenticated as that App via JWT.
   * Default: creates a real Octokit with `@octokit/auth-app`.
   */
  octokitFactory?: (appId: number, privateKey: string) => Octokit;
}

// ── Error types ───────────────────────────────────────────────────────────────

/**
 * Thrown by {@link buildWizardConfig} when required state fields are missing.
 * The message lists every missing field so the operator can diagnose the issue.
 */
export class IncompleteStateError extends Error {
  readonly missingFields: string[];
  constructor(missingFields: string[]) {
    super(
      `Cannot render .env — the following required fields are missing from the wizard state:\n` +
        missingFields.map((f) => `  • ${f}`).join('\n') +
        `\nRun "agentify-setup resume" to complete the missing steps.`,
    );
    this.name = 'IncompleteStateError';
    this.missingFields = missingFields;
  }
}

// ── WizardState → WizardConfig conversion ────────────────────────────────────

/**
 * Convert one {@link PersonaCreds} from state (numeric IDs, `pem` field) to the
 * `AppCredentials` shape expected by {@link renderEnv} (string IDs, `privateKey`).
 */
function credsToAppCredentials(
  creds: PersonaCreds,
): WizardConfig['coordinator'] {
  // At runtime, pem has been decrypted to a string before the finalize phase
  // runs (the decryptStateOnLoad helper is wired in #492).
  // The union type `string | EncryptedValue` is the on-disk schema; by this
  // point in the orchestrator it is always a plaintext string.
  return {
    appId: String(creds.appId),
    installationId: String(creds.installationId),
    privateKey: creds.pem as string,
    githubUser: creds.githubUser,
  };
}

/**
 * Build a {@link WizardConfig} from the completed {@link WizardState}.
 *
 * Throws {@link IncompleteStateError} when any required credential is absent.
 */
function buildWizardConfig(state: WizardState): WizardConfig {
  const missing: string[] = [];

  // ── Coordinator ──────────────────────────────────────────────────────────────
  if (!state.coordinator) {
    missing.push('coordinator');
  }

  // ── Personas ─────────────────────────────────────────────────────────────────
  for (const persona of BUILTIN_PERSONAS) {
    if (!state.personas[persona]) {
      missing.push(`personas.${persona}`);
    }
  }

  // ── Anthropic ────────────────────────────────────────────────────────────────
  if (!state.anthropic) {
    missing.push('anthropic');
  }

  if (missing.length > 0) {
    throw new IncompleteStateError(missing);
  }

  // All required fields are present — build the config object.
  const coordinator = credsToAppCredentials(state.coordinator!);
  const personas = Object.fromEntries(
    BUILTIN_PERSONAS.map((p) => [p, credsToAppCredentials(state.personas[p]!)]),
  ) as WizardConfig['personas'];

  return {
    prefix: state.prefix,
    repo: { owner: state.repo.owner, name: state.repo.name },
    coordinator,
    personas,
    anthropic: state.anthropic!,
    tunables: state.tunables,
  };
}

// ── Atomic .env write ─────────────────────────────────────────────────────────

/**
 * Write `content` to `filePath` atomically (temp-file + rename) with mode 0600.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const uid = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tmp = `${filePath}.${uid}.tmp`;
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of the tmp file on error.
    await fs.unlink(tmp).catch(() => void 0);
    throw err;
  }
}

// ── runFinalize ───────────────────────────────────────────────────────────────

/**
 * Render the completed wizard state to a `.env` file.
 *
 * Behaviour:
 *  - Resolves the output path: `deps.envOut ?? <cwd>/.env`.
 *  - If `deps.dryRun` is true, writes the rendered content to stdout instead.
 *  - If the target path already exists, prompts: overwrite / write .env.new / abort.
 *  - Writes atomically (temp-file rename) with mode 0o600.
 *  - On success, prints next-step hints to stdout.
 *
 * @throws {IncompleteStateError} When the state is missing required fields.
 * @throws {PromptCancelled}      When the user aborts the overwrite prompt.
 */
export async function runFinalize(deps: FinalizeDeps): Promise<{ envPath: string }> {
  const { state, io, dryRun = false } = deps;
  const cwd = deps.cwd ? deps.cwd() : process.cwd();
  const fileExistsFn = deps.fileExists ?? defaultFileExists;
  const writeEnvFileFn = deps.writeEnvFile ?? atomicWrite;

  // ── Step 1: build the config and render the .env ──────────────────────────
  const config = buildWizardConfig(state);
  const rendered = renderEnv(config);

  // ── Step 2: dry-run path ──────────────────────────────────────────────────
  if (dryRun) {
    printSection('Dry-run output (.env preview)', io);
    io.stdout.write(rendered);
    io.stdout.write('\n');
    printOk('(dry-run: no file was written)', io);
    return { envPath: path.join(cwd, '.env') };
  }

  // ── Step 3: resolve output path ───────────────────────────────────────────
  let envPath = deps.envOut ?? path.join(cwd, '.env');

  // ── Step 4: handle existing file ─────────────────────────────────────────
  if (await fileExistsFn(envPath)) {
    const choice = await askChoice<'overwrite' | 'new' | 'abort'>(
      `${envPath} already exists. How do you want to proceed?`,
      [
        { value: 'overwrite', label: `Overwrite ${envPath}` },
        {
          value: 'new',
          label: `Write next to it as ${envPath}.new`,
        },
        { value: 'abort', label: 'Abort without writing' },
      ],
      {},
      io,
    );

    if (choice === 'abort') {
      printWarn('Aborted — no file written.', io);
      return { envPath };
    }

    if (choice === 'new') {
      envPath = `${envPath}.new`;
    }
  }

  // ── Step 5: write the file ────────────────────────────────────────────────
  await writeEnvFileFn(envPath, rendered);
  const sizeKiB = (Buffer.byteLength(rendered, 'utf8') / 1024).toFixed(1);
  const varCount = (rendered.match(/^[A-Z_][A-Z0-9_]*/gm) ?? []).length;
  printOk(
    `Wrote ${envPath} (${varCount} vars, ${sizeKiB} KiB)`,
    io,
  );

  // ── Step 6: write docker-compose.yml + souls/<persona>.md ────────────────
  // Default behavior: an operator who installed via `npx @agenti-fy/setup`
  // and never cloned the source repo can run `docker compose up` against
  // the GHCR-published images without any extra steps. The wizard writes a
  // standalone compose pinned to its own version + the nine soul files so
  // bind-mounts resolve. Skipped if --no-compose was passed.
  if (!deps.noCompose) {
    const composeWritten = await writeComposeAndSouls(deps, envPath);
    if (composeWritten) {
      // Tell operators where the artifacts landed. The next-steps banner below
      // assumes both are in place.
      printOk(`Wrote ${composeWritten.composePath}`, io);
      printOk(
        `Wrote ${composeWritten.soulsCount} soul files into ${composeWritten.soulsDir}/`,
        io,
      );
    }
  }

  // ── Step 7: next-steps banner ─────────────────────────────────────────────
  printSection('Next steps', io);
  if (deps.noCompose) {
    io.stdout.write('  docker compose up -d --build\n');
  } else {
    io.stdout.write('  docker compose up -d\n');
  }
  io.stdout.write('  pnpm e2e:doctor\n\n');

  return { envPath };
}

// ── compose + souls write helper ──────────────────────────────────────────────

interface ComposeWriteResult {
  composePath: string;
  soulsDir: string;
  soulsCount: number;
}

/**
 * Render docker-compose.yml + write the nine bundled soul files alongside it.
 *
 * Refuses to overwrite either an existing compose file or any existing soul
 * file — operators who already have customizations get a non-destructive
 * "skipping, file exists" warning per file. The .env write is unaffected
 * either way (this helper runs after the .env has already landed).
 *
 * Returns null when nothing was written (every output path collided). Returns
 * a summary object on partial or full success — caller surfaces the result
 * via the printOk lines in the runFinalize tail.
 */
async function writeComposeAndSouls(
  deps: FinalizeDeps,
  envPath: string,
): Promise<ComposeWriteResult | null> {
  const { io } = deps;
  const fileExistsFn = deps.fileExists ?? defaultFileExists;
  const loadSoulsFn = deps.loadBundledSouls ?? defaultLoadBundledSouls;

  // Resolve compose output path: --compose-out, else sibling of envPath.
  const composePath =
    deps.composeOut ?? path.join(path.dirname(envPath), 'docker-compose.yml');
  const baseDir = path.dirname(composePath);
  const soulsDir = path.join(baseDir, 'souls');

  // Image tag default: caller passes wizard's own VERSION; absent that, fall
  // back to 'latest' so the generator never produces ":undefined".
  const imageTag = deps.imageTag ?? 'latest';
  const composeOpts: Parameters<typeof renderCompose>[0] = { imageTag };
  if (deps.imageRegistry !== undefined) {
    composeOpts.imageRegistry = deps.imageRegistry;
  }

  // ── Write the compose file ───────────────────────────────────────────────
  const composeContent = renderCompose(composeOpts);
  let composeWasWritten = false;
  if (await fileExistsFn(composePath)) {
    printWarn(
      `Skipping ${composePath} — file exists. Delete or rename it and re-run, ` +
        `or pass --compose-out <path> for an alternate location.`,
      io,
    );
  } else {
    // Compose file gets mode 0644 (not 0600 like .env) — it has no secrets.
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(composePath, composeContent, { encoding: 'utf8', mode: 0o644 });
    composeWasWritten = true;
  }

  // ── Write the souls/ directory ───────────────────────────────────────────
  let soulsCount = 0;
  let bundledSouls: Readonly<Record<string, string>>;
  try {
    bundledSouls = await loadSoulsFn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printErr(`Failed to load bundled souls: ${msg}`, io);
    if (composeWasWritten) {
      return { composePath, soulsDir, soulsCount: 0 };
    }
    return null;
  }

  await fs.mkdir(soulsDir, { recursive: true });
  for (const [persona, content] of Object.entries(bundledSouls)) {
    const soulPath = path.join(soulsDir, `${persona}.md`);
    if (await fileExistsFn(soulPath)) {
      printWarn(
        `Skipping ${soulPath} — file exists. Existing customization preserved.`,
        io,
      );
      continue;
    }
    await fs.writeFile(soulPath, content, { encoding: 'utf8', mode: 0o644 });
    soulsCount += 1;
  }

  // Nothing-was-written case: skip the printOk in the caller by returning null.
  if (!composeWasWritten && soulsCount === 0) return null;
  return { composePath, soulsDir, soulsCount };
}

// ── runVerify ─────────────────────────────────────────────────────────────────

/**
 * Re-check an already-written `.env` file without re-running the wizard.
 *
 * Checks performed (doctor-style checklist):
 *  1. Coordinator block (4 keys) is present and non-empty.
 *  2. Anthropic block (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) is present.
 *  3. Nine persona blocks (4 keys each) are present and non-empty.
 *  4. Every private-key value parses as a valid PEM block (matching
 *     `-----BEGIN … PRIVATE KEY-----` / `-----END … PRIVATE KEY-----` headers).
 *  5. Each App's credentials are valid (GET /app JWT-auth call succeeds).
 *  6. Each App's installation is still active (GET /app/installations/{id}).
 *
 * Prints a doctor-style checklist to stdout.  Returns 0 when all checks pass,
 * 1 when any check fails.
 */
export async function runVerify(deps: VerifyDeps): Promise<number> {
  const { io } = deps;
  const cwd = deps.cwd ? deps.cwd() : process.cwd();
  const envPath = deps.envPath ?? path.join(cwd, '.env');
  const readFileFn = deps.readEnvFile ?? defaultReadFile;
  const octokitFn = deps.octokitFactory ?? defaultOctokitFactory;

  printSection('Verifying .env', io);
  io.stdout.write(`  Path: ${envPath}\n\n`);

  // ── Step 1: read and parse the .env ──────────────────────────────────────
  let env: Record<string, string>;
  try {
    const content = await readFileFn(envPath);
    env = parseDotenv(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printErr(`Cannot read ${envPath}: ${msg}`, io);
    return 1;
  }

  let allPassed = true;

  function check(label: string, passed: boolean, detail?: string): void {
    if (passed) {
      printOk(label, io);
    } else {
      printErr(detail ? `${label} — ${detail}` : label, io);
      allPassed = false;
    }
  }

  // ── Step 2: structural checks ─────────────────────────────────────────────

  printSection('Structural checks', io);

  // Coordinator block (4 keys)
  const COORD_KEYS = [
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_INSTALLATION_ID',
    'GITHUB_USER',
  ] as const;
  for (const key of COORD_KEYS) {
    check(key, Boolean(env[key]), 'missing or empty');
  }

  // Anthropic block (one of two keys)
  const hasApiKey = Boolean(env['ANTHROPIC_API_KEY']);
  const hasOauthToken = Boolean(env['CLAUDE_CODE_OAUTH_TOKEN']);
  check(
    'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN',
    hasApiKey || hasOauthToken,
    'neither key is present',
  );

  // Nine persona blocks
  for (const persona of BUILTIN_PERSONAS) {
    const prefix = persona.toUpperCase();
    const personaKeys = [
      `${prefix}_GITHUB_APP_ID`,
      `${prefix}_GITHUB_APP_INSTALLATION_ID`,
      `${prefix}_GITHUB_APP_PRIVATE_KEY`,
      `${prefix}_GITHUB_USER`,
    ] as const;
    for (const key of personaKeys) {
      check(key, Boolean(env[key]), 'missing or empty');
    }
  }

  // ── Step 3: PEM validation ────────────────────────────────────────────────

  printSection('PEM validation', io);

  const pemKeys = [
    'GITHUB_APP_PRIVATE_KEY',
    ...BUILTIN_PERSONAS.map((p) => `${p.toUpperCase()}_GITHUB_APP_PRIVATE_KEY`),
  ];
  for (const key of pemKeys) {
    const pem = env[key];
    if (!pem) continue; // already flagged above
    check(`${key} (PEM)`, isValidPem(pem), 'BEGIN/END header mismatch or missing');
  }

  // ── Step 4: API checks ────────────────────────────────────────────────────

  printSection('App credential checks', io);

  // Coordinator — build an AppEnv from the coordinator-specific env keys.
  const coordAppEnv: AppEnv = {
    GITHUB_APP_ID: env['GITHUB_APP_ID'],
    GITHUB_APP_PRIVATE_KEY: env['GITHUB_APP_PRIVATE_KEY'],
    GITHUB_APP_INSTALLATION_ID: env['GITHUB_APP_INSTALLATION_ID'],
  };
  await checkApp('coordinator', coordAppEnv, io, check, octokitFn);

  // Personas
  for (const persona of BUILTIN_PERSONAS) {
    const prefix = persona.toUpperCase();
    const appEnv = {
      GITHUB_APP_ID: env[`${prefix}_GITHUB_APP_ID`],
      GITHUB_APP_PRIVATE_KEY: env[`${prefix}_GITHUB_APP_PRIVATE_KEY`],
      GITHUB_APP_INSTALLATION_ID: env[`${prefix}_GITHUB_APP_INSTALLATION_ID`],
    };
    await checkApp(persona, appEnv, io, check, octokitFn);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  io.stdout.write('\n');
  if (allPassed) {
    printOk('All checks passed.', io);
  } else {
    printErr('One or more checks failed. Review the output above.', io);
  }

  return allPassed ? 0 : 1;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Returns true when `pem` has matching BEGIN/END headers. */
function isValidPem(pem: string): boolean {
  // Match any "BEGIN ... PRIVATE KEY" or "BEGIN RSA PRIVATE KEY" etc.
  const beginMatch = /-----BEGIN ([A-Z ]+)-----/.exec(pem);
  const endMatch = /-----END ([A-Z ]+)-----/.exec(pem);
  if (!beginMatch || !endMatch) return false;
  return beginMatch[1] === endMatch[1];
}

/** Check filesystem existence without throwing on ENOENT. */
async function defaultFileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a file as UTF-8 text. */
async function defaultReadFile(p: string): Promise<string> {
  return fs.readFile(p, 'utf8');
}

/** Create an App-JWT Octokit for the given App credentials. */
function defaultOctokitFactory(appId: number, privateKey: string): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
  });
}

/**
 * Shape used internally by {@link checkApp} to avoid repeating the key names.
 * Either the coordinator env-key prefix or a persona-specific subset.
 * Fields are typed as `string | undefined` (not strictly optional) so that
 * lookup results from `env[key]` (which returns `string | undefined`) can be
 * assigned directly without triggering `exactOptionalPropertyTypes` errors.
 */
interface AppEnv {
  GITHUB_APP_ID: string | undefined;
  GITHUB_APP_PRIVATE_KEY: string | undefined;
  GITHUB_APP_INSTALLATION_ID: string | undefined;
}

/**
 * Perform the two API checks (GET /app + GET /app/installations/{id}) for one
 * App credential set.  Writes check lines via `check()`.
 */
async function checkApp(
  label: string,
  appEnv: AppEnv,
  io: IoStreams,
  check: (label: string, passed: boolean, detail?: string) => void,
  octokitFactory: (appId: number, privateKey: string) => Octokit,
): Promise<void> {
  const appIdStr = appEnv.GITHUB_APP_ID;
  const privateKey = appEnv.GITHUB_APP_PRIVATE_KEY;
  const installationIdStr = appEnv.GITHUB_APP_INSTALLATION_ID;

  // Skip API checks if structural data is already missing.
  if (!appIdStr || !privateKey || !installationIdStr) {
    printWarn(`${label}: skipping API checks (missing credentials)`, io);
    return;
  }

  const appId = parseInt(appIdStr, 10);
  const installationId = parseInt(installationIdStr, 10);

  if (Number.isNaN(appId) || Number.isNaN(installationId)) {
    check(`${label} App ID / installation ID`, false, 'not valid integers');
    return;
  }

  // GET /app — verify App credentials.
  try {
    const octokit = octokitFactory(appId, privateKey);
    await octokit.apps.getAuthenticated();
    check(`${label} App credentials (GET /app)`, true);

    // GET /app/installations/{installation_id} — verify installation is live.
    try {
      await octokit.apps.getInstallation({ installation_id: installationId });
      check(`${label} installation ${installationId} (GET /app/installations/{id})`, true);
    } catch {
      check(
        `${label} installation ${installationId} (GET /app/installations/{id})`,
        false,
        'installation not found or not accessible',
      );
    }
  } catch {
    check(`${label} App credentials (GET /app)`, false, 'authentication failed');
    // Don't attempt installation check if App auth fails.
  }
}
