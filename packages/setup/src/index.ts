/**
 * index.ts — top-level wizard orchestrator.
 *
 * Exported surface
 * ----------------
 * {@link run}             – main entry; call from bin.ts.
 * {@link RunDeps}         – injectable dependencies (for testing).
 * {@link PhaseOpts}       – common options bag passed to every driver phase.
 * {@link runApps}         – per-persona App-creation loop (driver/apps.ts).
 * {@link runAnthropic}    – Anthropic auth + tunables driver (driver/anthropic.ts).
 * {@link runFinalize}     – .env write driver (driver/finalize.ts).
 * {@link runVerify}       – verify subcommand driver (driver/finalize.ts).
 *
 * Phase contract
 * --------------
 * Every driver phase receives {@link PhaseOpts} and returns
 * `Promise<Partial<WizardState>>`.  The orchestrator merges the returned
 * partial into the running state and calls `saveState` after each phase so
 * that a crash or Ctrl-C loses at most one phase of work.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { BUILTIN_PERSONAS } from '@agenti-fy/shared';
import type { CliArgs } from './cli.js';
import {
  PromptCancelled,
  printErr,
  printOk,
  askYesNo,
  type IoStreams,
} from './prompts.js';
import { loadState, saveState, stateForSave, type WizardState, type StateOptions } from './state.js';
import { getSessionPassphrase, type GetSessionPassphraseOpts } from './passphrase.js';
import { runPreamble, type GhExec } from './driver/preamble.js';
import { runApps } from './driver/apps.js';
import { runAnthropic } from './driver/anthropic.js';
import {
  runFinalize as driverRunFinalize,
  runVerify as driverRunVerify,
  type FinalizeDeps,
  type VerifyDeps,
} from './driver/finalize.js';
import {
  runInstallExisting as driverRunInstallExisting,
  type InstallExistingDeps,
} from './driver/install-existing.js';

// ── Phase types ───────────────────────────────────────────────────────────────

/**
 * Options passed to every driver phase.
 *
 * Each phase receives the **current** (already-merged) wizard state so it can
 * read fields populated by earlier phases.  The `io` pair allows tests to
 * inject PassThrough streams; production callers receive the real
 * process.stdin/stdout.
 */
export interface PhaseOpts {
  /** Current wizard state at the start of this phase. */
  state: WizardState;
  /** Injectable I/O streams.  Defaults to process.stdin/stdout. */
  io: IoStreams;
}

/**
 * Shape that every driver phase function must satisfy.
 *
 * The return value is merged into the running {@link WizardState} after the
 * phase completes; fields not returned by a phase are left unchanged.
 */
export type PhaseFn = (opts: PhaseOpts) => Promise<Partial<WizardState>>;

// ── Stub phases ───────────────────────────────────────────────────────────────

// runApps is the real implementation from driver/apps.ts — re-exported here so
// index.ts remains the single import point for the orchestrator and its tests.
export { runApps };

// runAnthropic — real implementation from driver/anthropic.ts.
// Re-exported here so index.ts remains the single import point for the
// orchestrator and its tests.
export { runAnthropic };

// runFinalize / runVerify — real implementations from driver/finalize.ts.
// Re-exported here for test injection and direct use by the orchestrator.
export { driverRunFinalize as runFinalize, driverRunVerify as runVerify };
// Also re-export the dep types so callers can reference them.
export type { FinalizeDeps, VerifyDeps };

// ── Injectable dependencies ───────────────────────────────────────────────────

/**
 * Dependency-injection bag for {@link run}.
 *
 * Every field is optional; omitting it uses the production default.
 * Tests substitute stubs to avoid real I/O, filesystem, and network calls.
 */
export interface RunDeps {
  /** Overrides process.stdin / process.stdout. */
  io?: IoStreams;
  /** Overrides the gh-CLI executor used by the preamble. */
  spawn?: GhExec;
  /** Overrides the preamble phase (full replacement). */
  runPreamble?: typeof runPreamble;
  /** Overrides the Apps phase. */
  runApps?: PhaseFn;
  /** Overrides the Anthropic phase. */
  runAnthropic?: PhaseFn;
  /** Overrides the Finalize phase (init/resume path). */
  runFinalize?: (deps: FinalizeDeps) => Promise<{ envPath: string }>;
  /** Overrides the Verify phase (verify subcommand path). */
  runVerify?: (deps: VerifyDeps) => Promise<number>;
  /** Overrides the install-existing phase (install subcommand path). */
  runInstallExisting?: (deps: InstallExistingDeps) => Promise<number>;
  /** Overrides the state-loader (useful for hermetic tests). */
  loadState?: (prefix: string, opts?: StateOptions) => Promise<WizardState | null>;
  /** Overrides the state-writer (useful for hermetic tests). */
  saveState?: (state: WizardState, opts?: { dir?: string }) => Promise<void>;
  /**
   * Test-injection escape hatch for passphrase acquisition.
   *
   * In production {@link getSessionPassphrase} is called to prompt the
   * operator interactively (or read `AGENTIFY_SETUP_PASSPHRASE`).  Tests
   * inject `async () => 'fixed-test-passphrase'` here to avoid touching
   * the masked-prompt loop.
   */
  passphraseProvider?: (io: IoStreams, opts?: GetSessionPassphraseOpts) => Promise<string>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Build a fresh {@link WizardState} skeleton from preamble results. */
function buildInitialState(
  prefix: string,
  repo: WizardState['repo'],
  ownerType: WizardState['ownerType'],
): WizardState {
  return {
    version: 2,
    prefix,
    repo,
    ownerType,
    coordinator: undefined,
    personas: Object.fromEntries(
      BUILTIN_PERSONAS.map((p: string) => [p, undefined]),
    ),
    anthropic: undefined,
    tunables: undefined,
  };
}

/**
 * Shallow-merge `patch` into `base`, deep-merging the `personas` sub-object.
 *
 * The `version` field is always taken from `base` (never patched).
 */
function mergeState(base: WizardState, patch: Partial<WizardState>): WizardState {
  return {
    ...base,
    ...patch,
    version: base.version,
    personas: {
      ...base.personas,
      ...(patch.personas ?? {}),
    },
  };
}

/** Derive the expected state file path from a prefix and an optional dir. */
function stateFilePath(prefix: string, dir?: string): string {
  const resolved = dir ?? path.join(os.homedir(), '.config', 'agentify');
  return path.join(resolved, `setup-${prefix}.json`);
}

/**
 * Count personas that already have full credentials in a loaded state.
 * Used to decide whether a saved state file represents "real progress"
 * worth resuming from — a freshly-built state with only preamble fields
 * filled in returns 0 here, in which case init won't prompt.
 */
function countCompletedPersonas(state: WizardState): number {
  return Object.values(state.personas).filter((v) => v != null).length;
}

// ── run ───────────────────────────────────────────────────────────────────────

/**
 * Top-level wizard orchestrator.
 *
 * Subcommand behaviour:
 *  - `init`   — always restarts from the preamble phase, ignoring credentials
 *               already in the state file (if any).
 *  - `resume` — loads the existing state file (keyed by `--prefix` if
 *               provided) and skips phases that are already fully populated.
 *  - `verify` — runs preamble + finalize only; used to re-check an existing
 *               .env without re-creating Apps.
 *
 * Error handling:
 *  - {@link PromptCancelled} (user pressed Ctrl-C or sent EOF) → prints a
 *    "saved progress" banner and returns exit code 130.
 *  - Any other error → prints the error message and state file path, returns
 *    exit code 1.
 *
 * State checkpointing:
 *  After every phase the merged state is written to disk so that a crash or
 *  interruption loses at most one phase of work.
 *
 * @param args Parsed CLI arguments from {@link parseArgs}.
 * @param deps Optional overrides for all I/O and phase functions (for testing).
 * @returns The process exit code (0 = success, 1 = error, 130 = cancelled).
 */
export async function run(args: CliArgs, deps?: RunDeps): Promise<number> {
  const io: IoStreams = deps?.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
  };
  const spawn = deps?.spawn;
  const loadFn = deps?.loadState ?? loadState;
  const saveFn = deps?.saveState ?? saveState;
  const preambleFn = deps?.runPreamble ?? runPreamble;
  const appsFn = deps?.runApps ?? runApps;
  const anthropicFn = deps?.runAnthropic ?? runAnthropic;
  const finalizeFn = deps?.runFinalize ?? driverRunFinalize;
  const verifyFn = deps?.runVerify ?? driverRunVerify;
  const installExistingFn = deps?.runInstallExisting ?? driverRunInstallExisting;
  const passphraseFn = deps?.passphraseProvider ?? getSessionPassphrase;

  // ── install subcommand: short-circuit before state load + passphrase ──────
  // The install subcommand operates entirely off an existing .env (App
  // credentials produced by a prior wizard run). It does NOT touch the
  // wizard's checkpoint state or require a passphrase — the .env is
  // plaintext at the operator boundary and that's where the App PEMs come
  // from. Doing this before the passphrase prompt and the preamble keeps
  // the install flow zero-ceremony: the operator just needs --repo.
  if (args.subcommand === 'install') {
    if (!args.repo) {
      io.stdout.write(
        'agentify-setup install: --repo <owner/name> is required.\n' +
          'Example: agentify-setup install --repo my-org/another-project\n',
      );
      return 2;
    }
    const [owner, name] = args.repo.split('/');
    if (!owner || !name) {
      io.stdout.write(
        `agentify-setup install: --repo must be in <owner>/<name> form (got "${args.repo}")\n`,
      );
      return 2;
    }
    const envPath = args.envIn ?? path.join(process.cwd(), '.env');
    return await installExistingFn({
      io,
      envPath,
      repo: { owner, name },
    });
  }

  // State files live in a directory; --state-file's dirname overrides the default.
  const stateDir = args.stateFile ? path.dirname(args.stateFile) : undefined;
  const stateOpts = stateDir ? { dir: stateDir } : undefined;

  // ── Main flow ─────────────────────────────────────────────────────────────

  // `state` is declared here so the error handler can reference `state?.prefix`.
  let state: WizardState | null = null;

  try {
    // Acquire the session passphrase once and cache it for the rest of the run.
    //
    // Called unconditionally for all subcommands.  For `verify`, runVerify does
    // not load or decrypt state, so the passphrase is acquired but never used for
    // decryption — this is intentional: a consistent entry-point keeps the UX
    // predictable and avoids a conditional prompt that would confuse operators.
    //
    // `PromptCancelled` from the masked-input prompt propagates into the existing
    // catch block below, returning exit code 130 (same as any other cancellation).
    const passphrase = await passphraseFn(io, { confirm: args.subcommand === 'init' });

    // ── Load initial state ──────────────────────────────────────────────────

    // For resume we attempt to pre-load state so the preamble can confirm existing
    // values.  For init we always start fresh (ignoring saved credentials) at
    // this stage — after the preamble resolves the prefix we re-attempt the
    // load below and prompt the operator to resume if progress exists.
    if (args.subcommand === 'resume') {
      // The prefix is needed to locate the state file; use the --prefix flag when
      // provided; otherwise preamble will ask and we re-attempt the load
      // after the preamble step.
      const lookupPrefix = args.prefix;
      if (lookupPrefix) {
        state = await loadFn(lookupPrefix, { ...stateOpts, passphrase });
      }
    }

    // Phase 1: Preamble (always runs; confirms from state when available).
    // exactOptionalPropertyTypes: only include `spawn` when it is defined.
    const preambleOpts = spawn !== undefined
      ? { state, io, spawn }
      : { state, io };
    const preambleResult = await preambleFn(preambleOpts);

    // ── Late state load (post-preamble) ─────────────────────────────────────
    //
    // If we still don't have state, look on disk now that the prefix is
    // resolved. This handles two cases the prior `init`-overwrites-progress
    // shape did not:
    //   - `agentify-setup resume` invoked WITHOUT `--prefix` — the prefix
    //     comes from the preamble prompt, so the file lookup couldn't happen
    //     earlier. Pick the saved state up automatically.
    //   - `agentify-setup init` re-run after a crash partway through the
    //     App-creation loop — the saved state for the same prefix represents
    //     completed work the operator probably wants to preserve. Prompt
    //     before reusing it, but default to yes.
    //
    // For `verify` we skip the prompt: verify doesn't touch the App loop and
    // operates on .env, so the on-disk checkpoint is irrelevant.
    if (state === null && args.subcommand !== 'verify') {
      const existing = await loadFn(preambleResult.prefix, {
        ...stateOpts,
        passphrase,
      });
      if (existing !== null) {
        const completed = countCompletedPersonas(existing);
        if (args.subcommand === 'resume' || completed === 0) {
          // Resume: take it without asking. Init with a saved file that has
          // no persona progress (preamble-only checkpoint): silently re-use,
          // since there's nothing meaningful to preserve or discard.
          state = existing;
          if (completed > 0) {
            printOk(
              `Resuming from saved progress (${completed}/${BUILTIN_PERSONAS.length} personas complete).`,
              io,
            );
          }
        } else {
          // init with real progress on disk — ask before overwriting.
          io.stdout.write(
            `\nFound saved progress for "${preambleResult.prefix}" — ` +
              `${completed}/${BUILTIN_PERSONAS.length} personas already created.\n`,
          );
          const resume = await askYesNo(
            'Resume from saved progress?',
            { default: true },
            io,
          );
          if (resume) {
            state = existing;
            printOk('Resuming from saved progress.', io);
          } else {
            io.stdout.write(
              '  Starting fresh — previously saved credentials for ' +
                `"${preambleResult.prefix}" will be overwritten.\n`,
            );
          }
        }
      }
    }

    // Build or update the running state.
    if (state === null) {
      state = buildInitialState(preambleResult.prefix, preambleResult.repo, preambleResult.ownerType);
    } else {
      state = mergeState(state, {
        prefix: preambleResult.prefix,
        repo: preambleResult.repo,
        ownerType: preambleResult.ownerType,
      });
    }
    await saveFn(stateForSave(state, passphrase), stateOpts);

    // verify subcommand: run verification against an existing .env, skipping
    // the App-creation and Anthropic phases.
    if (args.subcommand === 'verify') {
      // exactOptionalPropertyTypes: only include envPath when envOut is provided.
      const verifyOpts: VerifyDeps = { io };
      if (args.envOut !== undefined) verifyOpts.envPath = args.envOut;
      return await verifyFn(verifyOpts);
    }

    // Phase 2: Apps.
    const appsResult = await appsFn({ state, io, passphrase });
    state = mergeState(state, appsResult);
    await saveFn(stateForSave(state, passphrase), stateOpts);

    // Phase 3: Anthropic.
    const anthropicResult = await anthropicFn({ state, io });
    state = mergeState(state, anthropicResult);
    await saveFn(stateForSave(state, passphrase), stateOpts);

    // Phase 4: Finalize — write the .env file (or print if --dry-run).
    // The wizard ALSO writes a standalone docker-compose.yml + souls/ dir
    // alongside the .env so an operator who installed via `npx
    // @agenti-fy/setup` and never cloned the repo has a complete deploy
    // bundle. Skipped when --no-compose is passed.
    // exactOptionalPropertyTypes: only include optional fields when defined.
    const finalizeOpts: FinalizeDeps = { state, io };
    if (args.dryRun) finalizeOpts.dryRun = true;
    if (args.envOut !== undefined) finalizeOpts.envOut = args.envOut;
    if (args.noCompose) finalizeOpts.noCompose = true;
    if (args.composeOut !== undefined) finalizeOpts.composeOut = args.composeOut;
    if (args.imageTag !== undefined) finalizeOpts.imageTag = args.imageTag;
    await finalizeFn(finalizeOpts);
    await saveFn(stateForSave(state, passphrase), stateOpts);

    return 0;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      io.stdout.write(
        '\n⚠ Saved progress; resume with: agentify-setup resume\n',
      );
      return 130;
    }

    // Generic error: print message + state file path for diagnosis.
    const msg = err instanceof Error ? err.message : String(err);
    printErr(`Setup failed: ${msg}`, io);
    if (state?.prefix) {
      printErr(
        `State file: ${stateFilePath(state.prefix, stateDir)}`,
        io,
      );
    }
    return 1;
  }
}
