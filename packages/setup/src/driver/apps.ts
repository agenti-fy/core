/**
 * apps.ts — per-persona GitHub App-creation loop driver.
 *
 * Iterates the nine built-in personas in {@link WIZARD_PERSONAS} order.  For
 * each persona it orchestrates the GitHub App Manifest flow (browser open →
 * OAuth callback → credential exchange) followed by the installation handoff
 * (install URL → installation poll).  After each persona the captured
 * credentials are checkpointed to disk so an abort can be resumed cleanly.
 *
 * Exported surface
 * ----------------
 * {@link runApps}     – main entry; called by the index.ts orchestrator.
 * {@link AppsDeps}    – injectable dependencies (extends {@link PhaseOpts}).
 *
 * Coordinator convention
 * ----------------------
 * The **coordinator** service in docker-compose.yml uses the *global*
 * `${GITHUB_APP_*}` variables (lines 90-94), which the wizard maps to the
 * **orchestrator** persona's credentials.  This keeps the docker-compose.yml
 * coordinator block working without a separate 10th App.  If a dedicated
 * read-only coordinator App is ever needed, that is a follow-up; it is
 * out of scope here.
 */

import { randomBytes } from 'node:crypto';
import { WIZARD_PERSONAS } from '../personas.js';
import { buildManifest } from '../manifest.js';
import { manifestStartUrl } from '../manifest.js';
import { renderStartPage } from '../start-page.js';
import {
  CallbackServer,
  CallbackTimeoutError,
  type CallbackServerHandle,
} from '../callback-server.js';
import { exchangeManifest as defaultExchangeManifest } from '../manifest-exchange.js';
import {
  awaitInstallation as defaultAwaitInstallation,
  installUrl,
  type RepoRef,
} from '../install.js';
import { openInBrowser as defaultOpenInBrowser } from '../open.js';
import { saveState as defaultSaveState, stateForSave } from '../state.js';
import { InstallationTimeoutError } from '../install.js';
import {
  printSection,
  printOk,
  printWarn,
  PromptCancelled,
  askChoice,
  type IoStreams,
} from '../prompts.js';
import type { WizardState, PersonaCreds } from '../state.js';
import type { ExchangedApp } from '../manifest-exchange.js';
import type { BuiltinPersona } from '@agenti-fy/shared';

// ── Injectable dependency types ───────────────────────────────────────────────

/**
 * Opens a URL in the system's default browser.
 * The default implementation is {@link openInBrowser} from `open.ts`.
 */
type OpenInBrowser = (url: string) => Promise<void>;

/**
 * Persists wizard state to disk for checkpointing.
 * The default implementation is {@link saveState} from `state.ts`.
 */
type SaveState = (state: WizardState) => Promise<void>;

/**
 * Factory that creates and starts the local callback server.
 * Exactly one instance is created per {@link runApps} call and reused across
 * all nine personas to avoid port churn.
 * The default implementation is `() => CallbackServer.listen()`.
 */
type CallbackServerFactory = () => Promise<CallbackServerHandle>;

/**
 * Exchanges a manifest flow `code` for GitHub App credentials.
 * The default implementation is {@link exchangeManifest} from `manifest-exchange.ts`.
 */
type ExchangeManifest = (code: string) => Promise<ExchangedApp>;

/**
 * Polls until the GitHub App installation appears on the target repo.
 * The default implementation is {@link awaitInstallation} from `install.ts`.
 */
type AwaitInstallation = (
  app: ExchangedApp,
  repo: RepoRef,
) => Promise<{ installationId: number }>;

// ── AppsDeps ──────────────────────────────────────────────────────────────────

/**
 * Dependency-injection bag for {@link runApps}.
 *
 * Mirrors the `PhaseOpts` shape (providing `state` and `io`) and adds optional
 * overrides for every I/O-performing operation.  Omitting an override uses the
 * production default.  Tests inject stubs for every dep to run without a real
 * browser, network, or filesystem.
 *
 * Note: this interface is NOT imported from `index.ts` (which imports from
 * this file) to avoid a circular-dependency cycle.  The shape is identical to
 * `PhaseOpts & { ...optional extras }`, so it is structurally assignable to
 * `PhaseFn`'s parameter type and `runApps` can be used as a `PhaseFn` directly.
 */
export interface AppsDeps {
  /**
   * Current wizard state at the start of the Apps phase.
   * Must contain `prefix`, `repo`, and `ownerType` (populated by the preamble).
   */
  state: WizardState;
  /** Injectable I/O streams. Defaults to process.stdin/stdout in production. */
  io: IoStreams;
  /**
   * Operator's session passphrase, used to encrypt `pem`, `clientSecret`, and
   * `webhookSecret` fields in each per-persona checkpoint written to disk.
   *
   * Required in v2 of the setup wizard — every checkpoint must be written with
   * encryption active so that raw PEM material never touches the state file.
   * The orchestrator in `index.ts` acquires this once at startup (via
   * {@link getSessionPassphrase}) and threads it straight through here.
   */
  passphrase: string;
  /** Override the browser launcher (default: `openInBrowser` from `open.ts`). */
  openInBrowser?: OpenInBrowser;
  /** Override the state writer for per-persona checkpoints (default: `saveState`). */
  saveState?: SaveState;
  /**
   * Override the callback-server factory.  The factory is called **once** per
   * `runApps` invocation; the returned handle is reused across all personas.
   * Default: `() => CallbackServer.listen()`.
   */
  callbackServerFactory?: CallbackServerFactory;
  /** Override the manifest-exchange HTTP call (default: `exchangeManifest`). */
  exchangeManifest?: ExchangeManifest;
  /** Override the installation poller (default: `awaitInstallation`). */
  awaitInstallation?: AwaitInstallation;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a 32-byte (64 hex char) random state nonce for OAuth CSRF protection. */
function randomHex32(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Prompt the user to choose between retrying, skipping, or aborting.
 *
 * - **Retry**  — re-open the browser and try again.
 * - **Skip**   — leave this persona without credentials and move on.
 * - **Abort**  — throw {@link PromptCancelled} so the orchestrator persists
 *               state and exits with code 130, allowing a future `resume`.
 */
async function askRetrySkipAbort(
  io: IoStreams,
): Promise<'retry' | 'skip' | 'abort'> {
  return askChoice<'retry' | 'skip' | 'abort'>(
    'How do you want to proceed?',
    [
      { value: 'retry', label: 'Retry (open browser again)' },
      { value: 'skip', label: 'Skip this persona (no credentials captured)' },
      { value: 'abort', label: 'Abort setup (progress is saved; resume later)' },
    ],
    {},
    io,
  );
}

// ── runApps ───────────────────────────────────────────────────────────────────

/**
 * Per-persona App-creation loop.
 *
 * For each of the nine built-in personas (in {@link WIZARD_PERSONAS} order):
 *  1. Checks whether the persona already has full credentials in `state`; if
 *     so, logs "skipping (already created)" and moves on without any browser
 *     interaction.
 *  2. Generates a fresh 32-byte hex CSRF nonce.
 *  3. Builds the manifest payload, the auto-POST start page, and stages them
 *     on the shared callback server.
 *  4. Opens the browser to `<baseUrl>/start?persona=<name>`.
 *  5. Awaits the OAuth callback (`?code=&state=`) from GitHub.
 *  6. Exchanges the code for GitHub App credentials via `POST /app-manifests/{code}/conversions`.
 *  7. Opens the installation URL and polls until the installation is confirmed.
 *  8. Saves the persona's credentials to disk (checkpoint).
 *
 * On `CallbackTimeoutError` or `InstallationTimeoutError` the function
 * prompts the user to retry / skip / abort.  Abort throws {@link PromptCancelled}
 * so the orchestrator's catch block saves progress and exits gracefully.
 *
 * The **coordinator** credentials are set to the first persona (orchestrator)
 * by convention — see module-level JSDoc for details.
 *
 * @returns A `Partial<WizardState>` containing `coordinator` and all
 *          completed `personas` entries, suitable for merging into the
 *          running state by the {@link run} orchestrator.
 */
export async function runApps(deps: AppsDeps): Promise<Partial<WizardState>> {
  const { state, io, passphrase } = deps;
  const openBrowser: OpenInBrowser =
    deps.openInBrowser ?? ((url) => defaultOpenInBrowser(url).then(() => void 0));
  const saveFn: SaveState = deps.saveState ?? defaultSaveState;
  const serverFactory: CallbackServerFactory =
    deps.callbackServerFactory ?? (() => CallbackServer.listen());
  const exchangeFn: ExchangeManifest = deps.exchangeManifest ?? defaultExchangeManifest;
  const awaitInstallFn: AwaitInstallation =
    deps.awaitInstallation ??
    ((app, repo) => defaultAwaitInstallation(app, repo));

  const { prefix, repo, ownerType } = state;

  // Start exactly one callback server; it is reused across all 9 personas.
  const server = await serverFactory();
  const callbackUrl = `${server.baseUrl}/callback`;

  // Accumulate completed credentials as we loop; used to build the return value.
  const completedPersonas: Partial<Record<BuiltinPersona, PersonaCreds>> = {};

  // Seed completed map from already-saved state so skip logic is consistent.
  for (const persona of WIZARD_PERSONAS) {
    const saved = state.personas[persona.name];
    if (saved != null) {
      completedPersonas[persona.name] = saved;
    }
  }

  try {
    for (let i = 0; i < WIZARD_PERSONAS.length; i++) {
      const persona = WIZARD_PERSONAS[i]!;
      const personaIndex = i + 1;

      // ── Skip if already complete ────────────────────────────────────────

      const existing = state.personas[persona.name];
      if (existing != null) {
        printOk(`Skipping ${persona.name} (already created)`, io);
        continue;
      }

      printSection(
        `Creating App #${personaIndex}/${WIZARD_PERSONAS.length}: ${prefix}-${persona.name}`,
        io,
      );

      // ── Manifest / callback phase (with retry on timeout) ───────────────

      const manifestResult = await runManifestPhase({
        persona: persona.name,
        prefix,
        ownerType,
        orgLogin: ownerType === 'organization' ? repo.owner : undefined,
        callbackUrl,
        server,
        openBrowser,
        exchangeFn,
        io,
      });

      if (manifestResult.kind === 'skip') {
        printWarn(`Skipped ${persona.name} — no credentials captured.`, io);
        continue;
      }

      const exchanged = manifestResult.exchanged;
      printOk(`App created (id=${exchanged.id}, slug=${exchanged.slug})`, io);

      // ── Installation phase (with retry on timeout) ──────────────────────

      // exactOptionalPropertyTypes: only include ownerId / repoId when present.
      const repoRef: RepoRef = { owner: repo.owner, name: repo.name };
      if (typeof repo.ownerId === 'number') repoRef.ownerId = repo.ownerId;
      if (typeof repo.repoId === 'number') repoRef.repoId = repo.repoId;

      const url = installUrl(exchanged, repoRef);
      io.stdout.write(
        `  Now install on ${repo.owner}/${repo.name}: opening installation URL …\n`,
      );
      await openBrowser(url);

      const installResult = await runInstallPhase({
        exchanged,
        repoRef,
        awaitInstallFn,
        io,
      });

      if (installResult.kind === 'skip') {
        printWarn(
          `Skipped installation for ${persona.name} — no credentials captured.`,
          io,
        );
        continue;
      }

      const { installationId } = installResult;
      printOk(`Installation captured (installation_id=${installationId})`, io);

      // ── Build and checkpoint credentials ───────────────────────────────

      const creds: PersonaCreds = {
        appId: exchanged.id,
        slug: exchanged.slug,
        name: exchanged.name,
        htmlUrl: exchanged.htmlUrl,
        pem: exchanged.pem,
        clientId: exchanged.clientId,
        clientSecret: exchanged.clientSecret,
        webhookSecret: exchanged.webhookSecret,
        installationId,
        // The GitHub bot login is <slug>[bot] per the App Manifest flow docs.
        githubUser: `${exchanged.slug}[bot]`,
      };

      completedPersonas[persona.name] = creds;

      // Checkpoint: merge the new persona into the running state and persist.
      // Also update coordinator if this is the first (orchestrator) persona.
      const updatedPersonas = { ...state.personas, [persona.name]: creds };
      const updatedCoordinator =
        i === 0 ? creds : (state.coordinator ?? completedPersonas[WIZARD_PERSONAS[0]!.name]);

      const checkpointState: WizardState = {
        ...state,
        coordinator: updatedCoordinator,
        personas: updatedPersonas,
      };
      await saveFn(stateForSave(checkpointState, passphrase));
    }
  } finally {
    // Always close the server, even on error or PromptCancelled.
    await server.close();
  }

  // ── Build return value ──────────────────────────────────────────────────────

  // Coordinator = orchestrator (first persona) by convention.
  const firstPersonaName = WIZARD_PERSONAS[0]!.name;
  const coordinator = completedPersonas[firstPersonaName];

  return {
    coordinator,
    personas: completedPersonas,
  };
}

// ── Private phase helpers ─────────────────────────────────────────────────────

interface ManifestPhaseArgs {
  persona: BuiltinPersona;
  prefix: string;
  ownerType: 'personal' | 'organization';
  orgLogin: string | undefined;
  callbackUrl: string;
  server: CallbackServerHandle;
  openBrowser: OpenInBrowser;
  exchangeFn: ExchangeManifest;
  io: IoStreams;
}

type ManifestPhaseResult =
  | { kind: 'ok'; exchanged: ExchangedApp }
  | { kind: 'skip' };

/**
 * Drive the manifest-flow + manifest-exchange for one persona.
 *
 * Retries from scratch (new nonce) on `CallbackTimeoutError`.
 * Returns `{ kind: 'skip' }` when the user chooses to skip.
 * Throws `PromptCancelled` when the user chooses to abort.
 */
async function runManifestPhase(
  args: ManifestPhaseArgs,
): Promise<ManifestPhaseResult> {
  const {
    persona,
    prefix,
    ownerType,
    orgLogin,
    callbackUrl,
    server,
    openBrowser,
    exchangeFn,
    io,
  } = args;

  for (;;) {
    // Generate a fresh CSRF nonce for each attempt.
    const nonce = randomHex32();

    const manifest = buildManifest({ prefix, persona, callbackUrl });
    // exactOptionalPropertyTypes: only include orgLogin when it is defined.
    const startUrlArgs =
      ownerType === 'organization' && orgLogin !== undefined
        ? { ownerType: 'org' as const, orgLogin, state: nonce }
        : { ownerType: 'user' as const, state: nonce };
    const startUrl = manifestStartUrl(startUrlArgs);
    const html = renderStartPage({
      manifest,
      manifestStartUrl: startUrl,
      persona,
      appName: `${prefix}-${persona}`,
    });

    server.stage(persona, html, nonce);
    await openBrowser(`${server.baseUrl}/start?persona=${persona}`);

    let code: string;
    try {
      ({ code } = await server.awaitCallback(nonce));
    } catch (err) {
      if (err instanceof CallbackTimeoutError) {
        printWarn(`OAuth callback timed out for "${persona}".`, io);
        const choice = await askRetrySkipAbort(io);
        if (choice === 'retry') continue;
        if (choice === 'skip') return { kind: 'skip' };
        // abort
        throw new PromptCancelled('Aborted by user during callback wait');
      }
      throw err;
    }

    // Exchange the one-time code for App credentials.
    const exchanged = await exchangeFn(code);
    return { kind: 'ok', exchanged };
  }
}

interface InstallPhaseArgs {
  exchanged: ExchangedApp;
  repoRef: RepoRef;
  awaitInstallFn: AwaitInstallation;
  io: IoStreams;
}

type InstallPhaseResult =
  | { kind: 'ok'; installationId: number }
  | { kind: 'skip' };

/**
 * Poll for the App installation on the target repo.
 *
 * Retries (re-polls) on `InstallationTimeoutError`.
 * Returns `{ kind: 'skip' }` when the user chooses to skip.
 * Throws `PromptCancelled` when the user chooses to abort.
 */
async function runInstallPhase(args: InstallPhaseArgs): Promise<InstallPhaseResult> {
  const { exchanged, repoRef, awaitInstallFn, io } = args;

  for (;;) {
    try {
      const { installationId } = await awaitInstallFn(exchanged, repoRef);
      return { kind: 'ok', installationId };
    } catch (err) {
      if (err instanceof InstallationTimeoutError) {
        printWarn(`Installation polling timed out for "${exchanged.slug}".`, io);
        const choice = await askRetrySkipAbort(io);
        if (choice === 'retry') continue;
        if (choice === 'skip') return { kind: 'skip' };
        // abort
        throw new PromptCancelled('Aborted by user during installation wait');
      }
      throw err;
    }
  }
}
