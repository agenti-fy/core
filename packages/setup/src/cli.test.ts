import { describe, it, expect } from 'vitest';
import { parseArgs, CliError, type CliArgs } from './cli.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wrap a string[] as an argv slice (no leading node/script args). */
function parse(args: string[]): CliArgs {
  return parseArgs(args);
}

/** Assert that parsing throws a CliError whose message includes `fragment`. */
function expectCliError(args: string[], fragment: string): void {
  expect(() => parse(args)).toThrow(CliError);
  expect(() => parse(args)).toThrowError(fragment);
}

// ── Defaults ──────────────────────────────────────────────────────────────────

describe('defaults', () => {
  it('returns defaults for an empty argv', () => {
    const args = parse([]);
    expect(args).toEqual<CliArgs>({
      subcommand: 'init',
      prefix: undefined,
      repo: undefined,
      dryRun: false,
      stateFile: undefined,
      showHelp: false,
      showVersion: false,
    });
  });
});

// ── Subcommands ───────────────────────────────────────────────────────────────

describe('subcommands', () => {
  it('parses "init" positionally', () => {
    expect(parse(['init']).subcommand).toBe('init');
  });

  it('parses "resume" positionally', () => {
    expect(parse(['resume']).subcommand).toBe('resume');
  });

  it('parses "verify" positionally', () => {
    expect(parse(['verify']).subcommand).toBe('verify');
  });

  it('parses subcommand after -- separator', () => {
    expect(parse(['--', 'resume']).subcommand).toBe('resume');
    expect(parse(['--', 'verify']).subcommand).toBe('verify');
    expect(parse(['--', 'init']).subcommand).toBe('init');
  });

  it('last subcommand wins when repeated', () => {
    expect(parse(['init', 'resume']).subcommand).toBe('resume');
  });
});

// ── Flag: --prefix ────────────────────────────────────────────────────────────

describe('--prefix', () => {
  it('parses --prefix <value>', () => {
    expect(parse(['--prefix', 'myorg']).prefix).toBe('myorg');
  });

  it('parses --prefix=<value>', () => {
    expect(parse(['--prefix=acme']).prefix).toBe('acme');
  });

  it('throws CliError when value is missing', () => {
    expectCliError(['--prefix'], '--prefix requires a value');
  });

  it('throws CliError when next token is a flag', () => {
    expectCliError(['--prefix', '--repo'], '--prefix requires a value');
  });
});

// ── Flag: --repo ──────────────────────────────────────────────────────────────

describe('--repo', () => {
  it('parses --repo <owner/name>', () => {
    expect(parse(['--repo', 'acme/project']).repo).toBe('acme/project');
  });

  it('parses --repo=<value>', () => {
    expect(parse(['--repo=owner/repo']).repo).toBe('owner/repo');
  });

  it('throws CliError when value is missing', () => {
    expectCliError(['--repo'], '--repo requires a value');
  });
});

// ── Flag: --dry-run ───────────────────────────────────────────────────────────

describe('--dry-run', () => {
  it('sets dryRun to true', () => {
    expect(parse(['--dry-run']).dryRun).toBe(true);
  });

  it('defaults to false', () => {
    expect(parse([]).dryRun).toBe(false);
  });
});

// ── Flag: --state-file ────────────────────────────────────────────────────────

describe('--state-file', () => {
  it('parses --state-file <path>', () => {
    expect(parse(['--state-file', '/tmp/state.json']).stateFile).toBe('/tmp/state.json');
  });

  it('parses --state-file=<path>', () => {
    expect(parse(['--state-file=/home/user/.config/setup.json']).stateFile).toBe(
      '/home/user/.config/setup.json',
    );
  });

  it('throws CliError when value is missing', () => {
    expectCliError(['--state-file'], '--state-file requires a value');
  });
});

// ── Flag: --help ──────────────────────────────────────────────────────────────

describe('--help / -h', () => {
  it('sets showHelp via --help', () => {
    expect(parse(['--help']).showHelp).toBe(true);
  });

  it('sets showHelp via -h', () => {
    expect(parse(['-h']).showHelp).toBe(true);
  });

  it('showHelp short-circuits: other flags still parse (caller decides what to do)', () => {
    // The parser does not exit — bin.ts does.  But all flags are still parsed
    // so the caller can inspect the full arg set.
    const args = parse(['--help', '--prefix', 'x']);
    expect(args.showHelp).toBe(true);
    expect(args.prefix).toBe('x');
  });
});

// ── Flag: --version ───────────────────────────────────────────────────────────

describe('--version / -V', () => {
  it('sets showVersion via --version (long form parsed by tui uses -V)', () => {
    expect(parse(['-V']).showVersion).toBe(true);
  });

  it('combined --version with a subcommand still sets showVersion', () => {
    const args = parse(['-V', 'resume']);
    expect(args.showVersion).toBe(true);
    expect(args.subcommand).toBe('resume');
  });
});

// ── Mutually exclusive flags ──────────────────────────────────────────────────

describe('mutually exclusive flags', () => {
  it('rejects --dry-run combined with --state-file', () => {
    expectCliError(
      ['--dry-run', '--state-file', '/tmp/s.json'],
      '--dry-run and --state-file are mutually exclusive',
    );
  });

  it('rejects --state-file combined with --dry-run (order does not matter)', () => {
    expectCliError(
      ['--state-file', '/tmp/s.json', '--dry-run'],
      '--dry-run and --state-file are mutually exclusive',
    );
  });
});

// ── Unknown flags ─────────────────────────────────────────────────────────────

describe('unknown flags', () => {
  it('throws CliError for an unrecognised long flag', () => {
    expectCliError(['--unknown-flag'], 'Unknown flag: --unknown-flag');
  });

  it('throws CliError for an unrecognised short flag', () => {
    expectCliError(['-x'], 'Unknown flag: -x');
  });

  it('error message points to --help', () => {
    expectCliError(['--foo'], '--help');
  });

  it('throws CliError for an unexpected positional argument', () => {
    expectCliError(['initt'], 'Unexpected argument: initt');
  });
});

// ── Combined flags ────────────────────────────────────────────────────────────

describe('combined flags', () => {
  it('parses a realistic init command', () => {
    const args = parse(['init', '--prefix', 'myorg', '--repo', 'acme/project']);
    expect(args).toMatchObject<Partial<CliArgs>>({
      subcommand: 'init',
      prefix: 'myorg',
      repo: 'acme/project',
      dryRun: false,
      stateFile: undefined,
    });
  });

  it('parses a dry-run verify command', () => {
    const args = parse(['verify', '--dry-run']);
    expect(args.subcommand).toBe('verify');
    expect(args.dryRun).toBe(true);
  });

  it('parses resume with a custom state file', () => {
    const args = parse(['resume', '--state-file', '/tmp/s.json', '--prefix', 'test']);
    expect(args.subcommand).toBe('resume');
    expect(args.stateFile).toBe('/tmp/s.json');
    expect(args.prefix).toBe('test');
  });

  it('parses flags before and after the subcommand', () => {
    const args = parse(['--prefix', 'x', 'resume', '--repo', 'a/b']);
    expect(args.subcommand).toBe('resume');
    expect(args.prefix).toBe('x');
    expect(args.repo).toBe('a/b');
  });
});
