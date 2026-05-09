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

/** The four wizard subcommands. */
export type Subcommand = 'init' | 'resume' | 'verify' | 'install';

/**
 * Parsed CLI arguments returned by `parseArgs`.
 *
 * Defaults: subcommand='init', all string fields=undefined, booleans=false.
 */
export interface CliArgs {
  /** Active subcommand. Defaults to 'init'. */
  subcommand: Subcommand;
  /** `--prefix <s>` — name prefix for the nine GitHub Apps (e.g. "myorg"). */
  prefix: string | undefined;
  /** `--repo <owner/name>` — target repository. */
  repo: string | undefined;
  /** `--dry-run` — write generated .env to stdout instead of disk. */
  dryRun: boolean;
  /**
   * `--env-out <path>` — override the default `.env` output path.
   * Defaults to `<cwd>/.env` when not provided.
   */
  envOut: string | undefined;
  /**
   * `--state-file <path>` — override the default state file location.
   * Mutually exclusive with `--dry-run`.
   */
  stateFile: string | undefined;
  /**
   * `--env-in <path>` — override the default `.env` input path for the
   * `install` subcommand (default: `<cwd>/.env`). The `install` subcommand
   * reads existing App credentials from this file rather than registering
   * fresh Apps.
   */
  envIn: string | undefined;
  /**
   * `--no-compose` — skip generating `docker-compose.yml` and `souls/`. By
   * default the wizard writes both alongside the `.env` so an operator who
   * never cloned the source repo still has everything they need to run
   * `docker compose up`.
   */
  noCompose: boolean;
  /**
   * `--image-tag <tag>` — override the image tag used in the generated
   * `docker-compose.yml`. Defaults to the wizard's own `package.json`
   * version, so a `0.3.1` wizard pins both `coordinator` and `agent` to
   * `:0.3.1`. Pass `latest` to track tip, or an older version to pin
   * earlier.
   */
  imageTag: string | undefined;
  /**
   * `--compose-out <path>` — override the default `docker-compose.yml`
   * output path (default: `<cwd>/docker-compose.yml`). Souls are written to
   * `<dirname-of-compose-out>/souls/<persona>.md` regardless of this flag.
   */
  composeOut: string | undefined;
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
    envOut: undefined,
    stateFile: undefined,
    envIn: undefined,
    noCompose: false,
    imageTag: undefined,
    composeOut: undefined,
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

    if (a === '--env-out') {
      const [v, newI] = consumeValue(a, argv, i);
      args.envOut = v;
      i = newI;
      continue;
    }
    if (a.startsWith('--env-out=')) {
      args.envOut = a.slice('--env-out='.length);
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

    if (a === '--env-in') {
      const [v, newI] = consumeValue(a, argv, i);
      args.envIn = v;
      i = newI;
      continue;
    }
    if (a.startsWith('--env-in=')) {
      args.envIn = a.slice('--env-in='.length);
      continue;
    }

    if (a === '--image-tag') {
      const [v, newI] = consumeValue(a, argv, i);
      args.imageTag = v;
      i = newI;
      continue;
    }
    if (a.startsWith('--image-tag=')) {
      args.imageTag = a.slice('--image-tag='.length);
      continue;
    }

    if (a === '--compose-out') {
      const [v, newI] = consumeValue(a, argv, i);
      args.composeOut = v;
      i = newI;
      continue;
    }
    if (a.startsWith('--compose-out=')) {
      args.composeOut = a.slice('--compose-out='.length);
      continue;
    }

    // ── Boolean flags ─────────────────────────────────────────────────────
    if (a === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (a === '--no-compose') {
      args.noCompose = true;
      continue;
    }

    // ── End-of-flags separator ────────────────────────────────────────────
    if (a === '--') {
      // Next token (if a valid subcommand) is treated as positional.
      const next = argv[i + 1];
      if (next === 'init' || next === 'resume' || next === 'verify' || next === 'install') {
        args.subcommand = next;
        i++;
      }
      continue;
    }

    // ── Positional subcommands ────────────────────────────────────────────
    if (a === 'init' || a === 'resume' || a === 'verify' || a === 'install') {
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
