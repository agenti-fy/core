/**
 * preamble.test.ts — unit tests for the preamble wizard phase.
 *
 * All tests inject PassThrough streams (io) and a stub GhExec so no real TTY
 * or gh binary is needed.  The stubbed spawn returns canned { status, stdout,
 * stderr } objects keyed by the args[0] command name.
 */

import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import {
  runPreamble,
  PREFIX_RE,
  type GhExec,
  type PreambleOpts,
} from './preamble.js';
import { PromptCancelled } from '../prompts.js';
import type { IoStreams } from '../prompts.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a fake IoStreams pair driven by canned lines.
 *
 * Lines are written ONE PER TICK (chained setImmediate) so that each
 * readline.Interface created by prompt helpers can attach BEFORE the next line
 * arrives.  Writing all lines at once lets readline1 drain the buffer before
 * readline2 even exists, making readline2 see an empty stream and hang.
 */
function makeIo(lines: string[]): IoStreams & { output: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const remaining = [...lines];
  function writeNext() {
    const line = remaining.shift();
    if (line !== undefined) {
      stdin.write(`${line}\n`);
      setImmediate(writeNext);
    } else {
      stdin.end();
    }
  }
  setImmediate(writeNext);

  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  return {
    stdin,
    stdout,
    output: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Create an IoStreams pair that immediately reaches EOF. */
function makeEofIo(): IoStreams & { output: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  setImmediate(() => stdin.end());
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stdin, stdout, output: () => Buffer.concat(chunks).toString('utf8') };
}

interface StubSpawnEntry {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Build a GhExec stub from a map of expected args[0] → response.
 * Falls back to { status: 1, stdout: '', stderr: 'no stub' } for unknown commands.
 */
function makeSpawn(
  responses: Record<string, StubSpawnEntry | ((args: string[]) => StubSpawnEntry)>,
): GhExec {
  return (args) => {
    const key = args[0] ?? '';
    const entry = responses[key];
    if (entry === undefined) {
      return { status: 1, stdout: '', stderr: `no stub for "gh ${args.join(' ')}"` };
    }
    return typeof entry === 'function' ? entry(args) : entry;
  };
}

/** A GhExec that simulates an authenticated user, a valid repo, and a personal owner. */
const happySpawn = makeSpawn({
  auth: {
    status: 0,
    stdout: '',
    stderr: 'Logged in to github.com account alice (keyring)',
  },
  repo: {
    status: 0,
    stdout: JSON.stringify({ name: 'sandbox', owner: { login: 'alice', id: 1234 } }),
    stderr: '',
  },
  api: {
    status: 0,
    stdout: JSON.stringify({ login: 'alice', type: 'User' }),
    stderr: '',
  },
});

/** Minimal opts for the happy path (fresh init, no prior state). */
function makeOpts(lines: string[], spawn: GhExec = happySpawn): PreambleOpts {
  return {
    state: null,
    io: makeIo(lines),
    spawn,
  };
}

// ── PREFIX_RE ─────────────────────────────────────────────────────────────────

describe('PREFIX_RE', () => {
  it('accepts lowercase alphanumeric', () => {
    expect(PREFIX_RE.test('abc')).toBe(true);
    expect(PREFIX_RE.test('a1b')).toBe(true);
  });

  it('accepts hyphens within the prefix', () => {
    expect(PREFIX_RE.test('my-prefix')).toBe(true);
    expect(PREFIX_RE.test('a-b-c')).toBe(true);
  });

  it('accepts a single char', () => {
    expect(PREFIX_RE.test('a')).toBe(true);
    expect(PREFIX_RE.test('1')).toBe(true);
  });

  it('rejects leading hyphen', () => {
    expect(PREFIX_RE.test('-abc')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(PREFIX_RE.test('Abc')).toBe(false);
  });

  it('rejects prefix longer than 21 chars', () => {
    // 22 chars
    expect(PREFIX_RE.test('a'.repeat(22))).toBe(false);
    // exactly 21 chars is fine
    expect(PREFIX_RE.test('a'.repeat(21))).toBe(true);
  });

  it('rejects empty string', () => {
    expect(PREFIX_RE.test('')).toBe(false);
  });
});

// ── gh auth failure ───────────────────────────────────────────────────────────

describe('runPreamble — gh auth check', () => {
  it('throws when gh auth status exits non-zero', async () => {
    const spawn = makeSpawn({
      auth: { status: 1, stdout: '', stderr: 'not logged in' },
    });
    const io = makeEofIo();

    await expect(runPreamble({ state: null, io, spawn })).rejects.toThrow(
      /not authenticated/,
    );
  });

  it('includes diagnostics from stderr in the error message', async () => {
    const spawn = makeSpawn({
      auth: { status: 1, stdout: '', stderr: 'token expired' },
    });
    const io = makeEofIo();

    await expect(runPreamble({ state: null, io, spawn })).rejects.toThrow(
      /token expired/,
    );
  });
});

// ── Happy path (fresh init) ───────────────────────────────────────────────────

describe('runPreamble — fresh init', () => {
  it('returns prefix / repo / ownerType from user input', async () => {
    // lines: prefix, repo — owner type is inferred from gh api
    const result = await runPreamble(makeOpts(['myorg', 'alice/sandbox']));
    expect(result.prefix).toBe('myorg');
    expect(result.repo).toMatchObject({ owner: 'alice', name: 'sandbox' });
    expect(result.ownerType).toBe('personal');
  });

  it('prints a success tick for the auth check', async () => {
    const opts = makeOpts(['myorg', 'alice/sandbox']);
    await runPreamble(opts);
    expect((opts.io as ReturnType<typeof makeIo>).output()).toContain('✔');
  });

  it('prints the GitHub login extracted from auth stderr', async () => {
    const opts = makeOpts(['myorg', 'alice/sandbox']);
    await runPreamble(opts);
    expect((opts.io as ReturnType<typeof makeIo>).output()).toContain('alice');
  });
});

// ── Prefix validation ─────────────────────────────────────────────────────────

describe('runPreamble — prefix validation', () => {
  it('re-prompts when prefix fails regex, then accepts the valid one', async () => {
    // First input: invalid (uppercase); second: valid
    const result = await runPreamble(makeOpts(['BAD-PREFIX', 'goodprefix', 'alice/sandbox']));
    expect(result.prefix).toBe('goodprefix');
  });

  it('re-prompts on leading hyphen', async () => {
    const result = await runPreamble(makeOpts(['-bad', 'valid', 'alice/sandbox']));
    expect(result.prefix).toBe('valid');
  });
});

// ── Repo validation ───────────────────────────────────────────────────────────

describe('runPreamble — repo validation', () => {
  it('re-prompts when repo format is invalid, then accepts the valid one', async () => {
    // First repo input: bad format; second: valid
    const result = await runPreamble(makeOpts(['myorg', 'not-a-repo', 'alice/sandbox']));
    expect(result.repo.owner).toBe('alice');
    expect(result.repo.name).toBe('sandbox');
  });

  it('throws when gh repo view returns non-zero', async () => {
    const spawn = makeSpawn({
      auth: {
        status: 0,
        stdout: '',
        stderr: 'Logged in to github.com account alice (keyring)',
      },
      repo: { status: 1, stdout: '', stderr: 'Not Found' },
    });

    await expect(
      runPreamble({ state: null, io: makeIo(['myorg', 'alice/missing']), spawn }),
    ).rejects.toThrow(/not found or is not accessible/);
  });

  it('captures ownerId from gh repo view JSON', async () => {
    const result = await runPreamble(makeOpts(['myorg', 'alice/sandbox']));
    expect(result.repo.ownerId).toBe(1234);
  });
});

// ── Owner type inference ──────────────────────────────────────────────────────

describe('runPreamble — owner type', () => {
  it('infers "organization" when gh api returns type=Organization', async () => {
    const spawn = makeSpawn({
      auth: {
        status: 0,
        stdout: '',
        stderr: 'Logged in to github.com account alice (keyring)',
      },
      repo: {
        status: 0,
        stdout: JSON.stringify({ name: 'proj', owner: { login: 'acme', id: 99 } }),
        stderr: '',
      },
      api: {
        status: 0,
        stdout: JSON.stringify({ login: 'acme', type: 'Organization' }),
        stderr: '',
      },
    });

    const result = await runPreamble({
      state: null,
      io: makeIo(['mypfx', 'acme/proj']),
      spawn,
    });

    expect(result.ownerType).toBe('organization');
  });

  it('falls back to askChoice when gh api fails', async () => {
    const spawn = makeSpawn({
      auth: {
        status: 0,
        stdout: '',
        stderr: 'Logged in to github.com account alice (keyring)',
      },
      repo: {
        status: 0,
        stdout: JSON.stringify({ name: 'sandbox', owner: { login: 'alice', id: 5 } }),
        stderr: '',
      },
      api: { status: 1, stdout: '', stderr: 'error' },
    });

    // askChoice expects "1" (personal) or "2" (org) as key input
    const result = await runPreamble({
      state: null,
      io: makeIo(['myorg', 'alice/sandbox', '1']),
      spawn,
    });

    expect(result.ownerType).toBe('personal');
  });

  it('asks for "org" when user selects key "2"', async () => {
    const spawn = makeSpawn({
      auth: {
        status: 0,
        stdout: '',
        stderr: 'Logged in to github.com account alice (keyring)',
      },
      repo: {
        status: 0,
        stdout: JSON.stringify({ name: 'myrepo', owner: { login: 'bob', id: 7 } }),
        stderr: '',
      },
      api: { status: 1, stdout: '', stderr: '' },
    });

    const result = await runPreamble({
      state: null,
      io: makeIo(['pfx', 'bob/myrepo', '2']),
      spawn,
    });

    expect(result.ownerType).toBe('organization');
  });
});

// ── State-aware confirmation ──────────────────────────────────────────────────

describe('runPreamble — state-based confirmation', () => {
  /** Minimal WizardState-like object for testing; cast to satisfy types. */
  function fakeState(overrides?: Record<string, unknown>) {
    return {
      version: 2 as const,
      prefix: 'saved-prefix',
      repo: { owner: 'alice', name: 'repo', ownerId: 42 },
      ownerType: 'personal' as const,
      personas: {} as never,
      ...overrides,
    };
  }

  it('keeps prefix and repo when user answers "y" to both', async () => {
    const state = fakeState();
    const result = await runPreamble({
      state,
      io: makeIo(['y', 'y']),  // keep prefix, keep repo
      spawn: happySpawn,
    });
    expect(result.prefix).toBe('saved-prefix');
    expect(result.repo.owner).toBe('alice');
    expect(result.repo.name).toBe('repo');
    expect(result.ownerType).toBe('personal');
  });

  it('re-asks prefix when user answers "n" to keep-prefix', async () => {
    const state = fakeState();
    const result = await runPreamble({
      state,
      // n → don't keep prefix; enter new prefix; y → keep repo
      io: makeIo(['n', 'newprefix', 'y']),
      spawn: happySpawn,
    });
    expect(result.prefix).toBe('newprefix');
    expect(result.repo.owner).toBe('alice');  // kept repo
  });

  it('re-asks repo when user answers "n" to keep-repo', async () => {
    const state = fakeState();
    const result = await runPreamble({
      state,
      // y → keep prefix; n → don't keep repo; enter new repo
      io: makeIo(['y', 'n', 'alice/sandbox']),
      spawn: happySpawn,
    });
    expect(result.prefix).toBe('saved-prefix');
    // repo comes from happySpawn's stub: owner=alice, name=sandbox
    expect(result.repo.name).toBe('sandbox');
  });

  it('retains saved ownerType when repo is kept', async () => {
    const state = fakeState({ ownerType: 'organization' });
    const result = await runPreamble({
      state,
      io: makeIo(['y', 'y']),
      spawn: happySpawn,
    });
    expect(result.ownerType).toBe('organization');
  });
});

// ── PromptCancelled on EOF ────────────────────────────────────────────────────

describe('runPreamble — EOF cancellation', () => {
  it('throws PromptCancelled when stdin ends during prefix prompt', async () => {
    const io = makeEofIo();
    await expect(runPreamble({ state: null, io, spawn: happySpawn })).rejects.toThrow(
      PromptCancelled,
    );
  });
});
