/**
 * index.ts — top-level wizard orchestrator.
 *
 * Exported surface
 * ----------------
 * {@link run}             – main entry; call from bin.ts.
 * {@link RunDeps}         – injectable dependencies (for testing).
 * {@link PhaseOpts}       – common options bag passed to every driver phase.
 * {@link runApps}         – per-persona App-creation loop (driver/apps.ts).
 * {@link runAnthropic}    – Anthropic auth + tunables driver (#430).
 * {@link runFinalize}     – stub for the .env write + verify phase (#431).
 *
 * Phase contract
 * --------------
 * Every driver phase receives {@link PhaseOpts} and returns
 * `Promise<Partial<WizardState>>`.  The orchestrator merges the returned
 * partial into the running state and calls `saveState` after each phase so
 * that a crash or Ctrl-C loses at most one phase of work.
 *
 * Stub implementations
 * --------------------
 * `runFinalize` is an exported stub — it satisfies the
 * {@link PhaseFn} interface and passes all type checks, but does nothing.
 * Issue #431 will replace the function body.
 * `runApps` is the real implementation from driver/apps.ts (#428);
 * `runAnthropic` is the real implementation from driver/anthropic.ts (#430).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { BUILTIN_PERSONAS } from '@agentify/shared';
import type { CliArgs } from './cli.js';
import { PromptCancelled, printErr, type IoStreams } from './prompts.js';
import { loadState, saveState, type WizardState } from './state.js';
import { runPreamble, type GhExec } from './driver/preamble.js';
import { runApps } from './driver/apps.js';
import { runAnthropic } from './driver/anthropic.js';

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

// runAnthropic — real implementation from driver/anthropic.ts (#430).
// Re-exported here so index.ts remains the single import point for the
// orchestrator and its tests.
export { runAnthropic };

/**
 * **Stub — implemented by #430 (`driver/finalize.ts`).**
 *
 * Renders the collected state to a `.env` file (or stdout when `--dry-run`)
 * and, in verify mode, checks that all Apps are still reachable and
 * installations are active.
 *
 * Returns an empty partial (all writes are side-effects, not state mutations).
 */
export const runFinalize: PhaseFn = async (_opts) => {
  // TODO (#431): implement .env rendering and verify subcommand.
  return {};
};

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
  /** Overrides the Finalize phase. */
  runFinalize?: PhaseFn;
  /** Overrides the state-loader (useful for hermetic tests). */
  loadState?: (prefix: string, opts?: { dir?: string }) => Promise<WizardState | null>;
  /** Overrides the state-writer (useful for hermetic tests). */
  saveState?: (state: WizardState, opts?: { dir?: string }) => Promise<void>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Build a fresh {@link WizardState} skeleton from preamble results. */
function buildInitialState(
  prefix: string,
  repo: WizardState['repo'],
  ownerType: WizardState['ownerType'],
): WizardState {
  return {
    version: 1,
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
  const finalizeFn = deps?.runFinalize ?? runFinalize;

  // State files live in a directory; --state-file's dirname overrides the default.
  const stateDir = args.stateFile ? path.dirname(args.stateFile) : undefined;
  const stateOpts = stateDir ? { dir: stateDir } : undefined;

  // ── Load initial state ────────────────────────────────────────────────────

  // For resume we attempt to pre-load state so the preamble can confirm existing
  // values.  For init we always start fresh (ignoring saved credentials).
  let state: WizardState | null = null;
  if (args.subcommand === 'resume') {
    // The prefix is needed to locate the state file; use the --prefix flag when
    // provided; otherwise preamble will ask and we skip pre-loading here.
    const lookupPrefix = args.prefix;
    if (lookupPrefix) {
      state = await loadFn(lookupPrefix, stateOpts);
    }
  }

  // ── Main flow ─────────────────────────────────────────────────────────────

  try {
    // Phase 1: Preamble (always runs; confirms from state when available).
    // exactOptionalPropertyTypes: only include `spawn` when it is defined.
    const preambleOpts = spawn !== undefined
      ? { state, io, spawn }
      : { state, io };
    const preambleResult = await preambleFn(preambleOpts);

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
    await saveFn(state, stateOpts);

    // verify subcommand skips Apps and Anthropic phases.
    if (args.subcommand === 'verify') {
      const finalizeResult = await finalizeFn({ state, io });
      state = mergeState(state, finalizeResult);
      await saveFn(state, stateOpts);
      return 0;
    }

    // Phase 2: Apps.
    const appsResult = await appsFn({ state, io });
    state = mergeState(state, appsResult);
    await saveFn(state, stateOpts);

    // Phase 3: Anthropic.
    const anthropicResult = await anthropicFn({ state, io });
    state = mergeState(state, anthropicResult);
    await saveFn(state, stateOpts);

    // Phase 4: Finalize.
    const finalizeResult = await finalizeFn({ state, io });
    state = mergeState(state, finalizeResult);
    await saveFn(state, stateOpts);

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
