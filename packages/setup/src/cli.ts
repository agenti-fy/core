/**
 * cli.ts — argument parsing and subcommand routing for agentify-setup.
 *
 * Design notes:
 *   - No third-party parser (commander/yargs) — manual parsing matches repo style.
 *   - Unknown flags fail loud (opposite of the TUI's tolerant parser) so wizard
 *     misuse is caught early rather than silently ignored.
 *   - `parseArgs` is a pure function; it throws `CliError` on bad input so the
 *     caller decides how to surface the error (tests can catch, bin exits 1).
 *   - Subcommands may be positional (`agentify-setup resume`) or follow `--`
 *     (`agentify-setup -- resume`).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** The three wizard subcommands. */
export type Subcommand = 'init' | 'resume' | 'verify';

/**
 * Parsed CLI arguments returned by `parseArgs`.
 *
 * Defaults: subcommand='init', all string fields=undefined, booleans=false.
 */
export interface CliArgs {
  /** Active subcommand. Defaults to 'init'. */
  subcommand: Subcommand;
  /** `--prefix <s>` — name prefix for the ten GitHub Apps (e.g. "myorg"). */
  prefix: string | undefined;
  /** `--repo <owner/name>` — target repository. */
  repo: string | undefined;
  /** `--dry-run` — write generated .env to stdout instead of disk. */
  dryRun: boolean;
  /**
   * `--state-file <path>` — override the default state file location.
   * Mutually exclusive with `--dry-run`.
   */
  stateFile: string | undefined;
  /** `-h/--help` — print help and exit. */
  showHelp: boolean;
  /** `-V/--version` — print version and exit. */
  showVersion: boolean;
}

// ── Error ─────────────────────────────────────────────────────────────────────

/**
 * Thrown by `parseArgs` for unknown flags, missing required values, or
 * mutually-exclusive flag combinations.  The `exitCode` defaults to 1.
 *
 * `bin.ts` catches this, writes to stderr, and calls `process.exit(exitCode)`.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Consume the next token in `argv` after index `i` as a required value for
 * `flag`.  Returns `[value, newIndex]`.  Throws `CliError` if the next token
 * is absent or looks like another flag.
 */
function consumeValue(
  flag: string,
  argv: readonly string[],
  i: number,
): [string, number] {
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new CliError(`${flag} requires a value. Run agentify-setup --help for usage.`);
  }
  return [next, i + 1];
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

/**
 * Parse `argv` (typically `process.argv.slice(2)`) into a `CliArgs` object.
 *
 * Throws `CliError` for:
 *   - Unknown flags (those starting with `-` that are not recognised).
 *   - Flags that require a value but none was provided.
 *   - `--dry-run` combined with `--state-file` (mutually exclusive).
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    subcommand: 'init',
    prefix: undefined,
    repo: undefined,
    dryRun: false,
    stateFile: undefined,
    showHelp: false,
    showVersion: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;

    // ── Short-circuit flags ───────────────────────────────────────────────
    if (a === '-h' || a === '--help') {
      args.showHelp = true;
      continue;
    }
    if (a === '-V' || a === '--version') {
      args.showVersion = true;
      continue;
    }

    // ── Value flags ───────────────────────────────────────────────────────
    if (a === '--prefix') {
      const [v, newI] = consumeValue(a, argv, i);
      args.prefix = v;
      i = newI;
      continue;
    }
    if (a.startsWith('--prefix=')) {
      args.prefix = a.slice('--prefix='.length);
      continue;
    }

    if (a === '--repo') {
      const [v, newI] = consumeValue(a, argv, i);
      args.repo = v;
      i = newI;
      continue;
    }
    if (a.startsWith('--repo=')) {
      args.repo = a.slice('--repo='.length);
      continue;
    }

    if (a === '--state-file') {
      const [v, newI] = consumeValue(a, argv, i);
      args.stateFile = v;
      i = newI;
      continue;
    }
    if (a.startsWith('--state-file=')) {
      args.stateFile = a.slice('--state-file='.length);
      continue;
    }

    // ── Boolean flags ─────────────────────────────────────────────────────
    if (a === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    // ── End-of-flags separator ────────────────────────────────────────────
    if (a === '--') {
      // Next token (if a valid subcommand) is treated as positional.
      const next = argv[i + 1];
      if (next === 'init' || next === 'resume' || next === 'verify') {
        args.subcommand = next;
        i++;
      }
      continue;
    }

    // ── Positional subcommands ────────────────────────────────────────────
    if (a === 'init' || a === 'resume' || a === 'verify') {
      args.subcommand = a;
      continue;
    }

    // ── Unknown flag ──────────────────────────────────────────────────────
    if (a.startsWith('-')) {
      throw new CliError(
        `Unknown flag: ${a}. Run agentify-setup --help for usage.`,
      );
    }

    // Unknown positional (not a subcommand name) — treat as an error so the
    // wizard doesn't silently swallow typos like `agentify-setup initt`.
    throw new CliError(
      `Unexpected argument: ${a}. Run agentify-setup --help for usage.`,
    );
  }

  // ── Mutual exclusion ─────────────────────────────────────────────────────
  if (args.dryRun && args.stateFile !== undefined) {
    throw new CliError(
      '--dry-run and --state-file are mutually exclusive. Run agentify-setup --help for usage.',
    );
  }

  return args;
}
