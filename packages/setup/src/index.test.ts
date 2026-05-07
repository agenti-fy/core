/**
 * index.test.ts — unit tests for the top-level run() orchestrator.
 *
 * All tests inject stub implementations for every I/O + phase function so
 * nothing real is spawned, written to disk, or written to process.stdout.
 */

import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { run, type PhaseFn, type RunDeps, type FinalizeDeps, type VerifyDeps } from './index.js';
import { PromptCancelled } from './prompts.js';
import type { CliArgs } from './cli.js';
import type { IoStreams } from './prompts.js';
import type { WizardState } from './state.js';
import type { PreambleResult, PreambleOpts } from './driver/preamble.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid CliArgs for init subcommand. */
const initArgs: CliArgs = {
  subcommand: 'init',
  prefix: undefined,
  repo: undefined,
  dryRun: false,
  envOut: undefined,
  stateFile: undefined,
  showHelp: false,
  showVersion: false,
};

/** Build a CliArgs for a given subcommand. */
function args(subcommand: CliArgs['subcommand'], overrides: Partial<CliArgs> = {}): CliArgs {
  return { ...initArgs, subcommand, ...overrides };
}

/** Capture stdout writes to a string. */
function makeIo(): IoStreams & { output: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stdin, stdout, output: () => Buffer.concat(chunks).toString('utf8') };
}

/** A minimal WizardState that satisfies the schema. */
const MINIMAL_STATE: WizardState = {
  version: 1,
  prefix: 'test-prefix',
  repo: { owner: 'alice', name: 'repo' },
  ownerType: 'personal',
  coordinator: undefined,
  personas: {
    orchestrator: undefined,
    conductor: undefined,
    theorist: undefined,
    tinkerer: undefined,
    optimizer: undefined,
    glue: undefined,
    skeptic: undefined,
    crafter: undefined,
    scribe: undefined,
  },
  anthropic: undefined,
  tunables: undefined,
};

/** Preamble result that matches MINIMAL_STATE. */
const PREAMBLE_RESULT: PreambleResult = {
  prefix: 'test-prefix',
  repo: { owner: 'alice', name: 'repo' },
  ownerType: 'personal',
};

/** Build a stub preamble function that resolves with `result`. */
function stubPreamble(
  result: PreambleResult = PREAMBLE_RESULT,
): MockedFunction<(opts: PreambleOpts) => Promise<PreambleResult>> {
  const impl: (opts: PreambleOpts) => Promise<PreambleResult> = async (_opts) => result;
  return vi.fn(impl);
}

/** Build a stub phase that records calls and returns `patch`. */
function stubPhase(patch: Partial<WizardState> = {}): MockedFunction<PhaseFn> {
  const impl: PhaseFn = async (_opts) => patch;
  return vi.fn(impl);
}

/** Build a stub runFinalize that records calls and returns an envPath. */
function stubFinalize(
  envPath = '/stub/.env',
): MockedFunction<(deps: FinalizeDeps) => Promise<{ envPath: string }>> {
  const impl = async (_deps: FinalizeDeps): Promise<{ envPath: string }> => ({ envPath });
  return vi.fn(impl);
}

/** Build a stub runVerify that records calls and returns exitCode. */
function stubVerify(
  exitCode = 0,
): MockedFunction<(deps: VerifyDeps) => Promise<number>> {
  const impl = async (_deps: VerifyDeps): Promise<number> => exitCode;
  return vi.fn(impl);
}

/** A concrete holder for the deps used in tests. */
interface TestDeps extends RunDeps {
  io: IoStreams & { output: () => string };
  savedStates: WizardState[];
}

/** Build a deps bag with all stubs pre-wired. */
function makeDeps(overrides: Partial<RunDeps> = {}): TestDeps {
  const io = makeIo();
  const savedStates: WizardState[] = [];
  const preamble = stubPreamble();
  const apps = stubPhase();
  const anthropic = stubPhase();
  const finalize = stubFinalize();
  const verify = stubVerify();

  const deps: TestDeps = {
    io,
    savedStates,
    runPreamble: preamble,
    runApps: apps,
    runAnthropic: anthropic,
    runFinalize: finalize,
    runVerify: verify,
    loadState: vi.fn(async () => null),
    saveState: vi.fn(async (state: WizardState) => {
      savedStates.push(state);
    }),
  };

  // Apply overrides (except io which always stays as the captured local)
  if (overrides.runPreamble !== undefined) deps.runPreamble = overrides.runPreamble;
  if (overrides.runApps !== undefined) deps.runApps = overrides.runApps;
  if (overrides.runAnthropic !== undefined) deps.runAnthropic = overrides.runAnthropic;
  if (overrides.runFinalize !== undefined) deps.runFinalize = overrides.runFinalize;
  if (overrides.runVerify !== undefined) deps.runVerify = overrides.runVerify;
  if (overrides.loadState !== undefined) deps.loadState = overrides.loadState;
  if (overrides.saveState !== undefined) deps.saveState = overrides.saveState;
  if (overrides.spawn !== undefined) deps.spawn = overrides.spawn;

  return deps;
}

// ── init subcommand ───────────────────────────────────────────────────────────

describe('run — init', () => {
  it('returns 0 on success', async () => {
    const deps = makeDeps();
    const code = await run(args('init'), deps);
    expect(code).toBe(0);
  });

  it('does not call loadState (init always starts fresh)', async () => {
    const deps = makeDeps();
    await run(args('init'), deps);
    expect(deps.loadState).not.toHaveBeenCalled();
  });

  it('calls preamble, then apps, then anthropic, then finalize in order', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      runPreamble: vi.fn(async () => { order.push('preamble'); return PREAMBLE_RESULT; }),
      runApps: vi.fn(async () => { order.push('apps'); return {}; }),
      runAnthropic: vi.fn(async () => { order.push('anthropic'); return {}; }),
      runFinalize: vi.fn(async () => { order.push('finalize'); return { envPath: '/stub/.env' }; }),
    });

    await run(args('init'), deps);
    expect(order).toEqual(['preamble', 'apps', 'anthropic', 'finalize']);
  });

  it('saves state after preamble', async () => {
    const deps = makeDeps();
    await run(args('init'), deps);
    // saveState is called at least once — first time is after preamble
    expect(deps.saveState).toHaveBeenCalled();
    const calls = (deps.saveState as MockedFunction<NonNullable<RunDeps['saveState']>>).mock.calls;
    // First save: state built from preamble result
    const firstSave = calls[0]?.[0];
    expect(firstSave?.prefix).toBe('test-prefix');
    expect(firstSave?.repo.owner).toBe('alice');
  });

  it('saves state 4 times (after each of 4 phases)', async () => {
    const deps = makeDeps();
    await run(args('init'), deps);
    expect(deps.saveState).toHaveBeenCalledTimes(4);
  });

  it('merges partial state returned by apps phase', async () => {
    const savedStates: WizardState[] = [];
    const deps = makeDeps({
      runApps: vi.fn(async () => ({
        tunables: { LOG_LEVEL: 'debug' },
      })),
      saveState: vi.fn(async (state: WizardState) => { savedStates.push(state); }),
    });

    await run(args('init'), deps);

    // After apps phase (second saveState call)
    const afterApps = savedStates[1];
    expect(afterApps?.tunables?.LOG_LEVEL).toBe('debug');
  });

  it('does not persist anthropic secret to disk (v1 policy)', async () => {
    const savedStates: WizardState[] = [];
    const deps = makeDeps({
      runAnthropic: vi.fn(async () => ({
        anthropic: { kind: 'api_key' as const, value: 'sk-ant-supersecret' },
      })),
      saveState: vi.fn(async (state: WizardState) => { savedStates.push(state); }),
    });

    await run(args('init'), deps);

    // anthropic must be absent from every save (long-lived secret, v1 policy)
    for (const s of savedStates) {
      expect(s.anthropic).toBeUndefined();
    }
  });
});

// ── resume subcommand ─────────────────────────────────────────────────────────

describe('run — resume', () => {
  it('returns 0 on success', async () => {
    const deps = makeDeps({
      loadState: vi.fn(async () => MINIMAL_STATE),
    });
    const code = await run(args('resume', { prefix: 'test-prefix' }), deps);
    expect(code).toBe(0);
  });

  it('loads state when --prefix is provided', async () => {
    const loadFn = vi.fn(async () => MINIMAL_STATE);
    const deps = makeDeps({ loadState: loadFn });

    await run(args('resume', { prefix: 'test-prefix' }), deps);

    expect(loadFn).toHaveBeenCalledWith('test-prefix', undefined);
  });

  it('does not load state when --prefix is absent', async () => {
    const loadFn = vi.fn(async () => null);
    const deps = makeDeps({ loadState: loadFn });

    await run(args('resume'), deps);

    expect(loadFn).not.toHaveBeenCalled();
  });

  it('passes loaded state into preamble', async () => {
    const capturedOpts: PreambleOpts[] = [];
    const deps = makeDeps({
      loadState: vi.fn(async () => MINIMAL_STATE),
      runPreamble: vi.fn(async (opts: PreambleOpts) => {
        capturedOpts.push(opts);
        return PREAMBLE_RESULT;
      }),
    });

    await run(args('resume', { prefix: 'test-prefix' }), deps);

    expect(capturedOpts[0]?.state).toMatchObject({ prefix: 'test-prefix' });
  });

  it('calls all four phases in order', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      runPreamble: vi.fn(async () => { order.push('preamble'); return PREAMBLE_RESULT; }),
      runApps: vi.fn(async () => { order.push('apps'); return {}; }),
      runAnthropic: vi.fn(async () => { order.push('anthropic'); return {}; }),
      runFinalize: vi.fn(async () => { order.push('finalize'); return { envPath: '/stub/.env' }; }),
    });

    await run(args('resume'), deps);
    expect(order).toEqual(['preamble', 'apps', 'anthropic', 'finalize']);
  });
});

// ── verify subcommand ─────────────────────────────────────────────────────────

describe('run — verify', () => {
  it('returns 0 when runVerify returns 0', async () => {
    const deps = makeDeps({ runVerify: stubVerify(0) });
    const code = await run(args('verify'), deps);
    expect(code).toBe(0);
  });

  it('returns 1 when runVerify returns 1', async () => {
    const deps = makeDeps({ runVerify: stubVerify(1) });
    const code = await run(args('verify'), deps);
    expect(code).toBe(1);
  });

  it('calls preamble and runVerify but NOT apps, anthropic, or runFinalize', async () => {
    const deps = makeDeps();
    await run(args('verify'), deps);

    expect(deps.runPreamble).toHaveBeenCalledOnce();
    expect(deps.runVerify).toHaveBeenCalledOnce();
    expect(deps.runApps).not.toHaveBeenCalled();
    expect(deps.runAnthropic).not.toHaveBeenCalled();
    expect(deps.runFinalize).not.toHaveBeenCalled();
  });

  it('saves state once (after preamble only)', async () => {
    const deps = makeDeps();
    await run(args('verify'), deps);
    // verify: preamble saves (1), then runVerify is called and returns — no more saves
    expect(deps.saveState).toHaveBeenCalledTimes(1);
  });

  it('passes --env-out as envPath to runVerify when provided', async () => {
    let capturedDeps: VerifyDeps | null = null;
    const deps = makeDeps({
      runVerify: vi.fn(async (d: VerifyDeps) => { capturedDeps = d; return 0; }),
    });
    await run(args('verify', { envOut: '/custom/.env' }), deps);
    expect(capturedDeps).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect((capturedDeps! as VerifyDeps).envPath).toBe('/custom/.env');
  });
});

// ── PromptCancelled handling ──────────────────────────────────────────────────

describe('run — PromptCancelled / SIGINT path', () => {
  it('returns 130 when preamble throws PromptCancelled', async () => {
    const deps = makeDeps({
      runPreamble: vi.fn(async () => { throw new PromptCancelled(); }),
    });
    const code = await run(args('init'), deps);
    expect(code).toBe(130);
  });

  it('returns 130 when apps phase throws PromptCancelled', async () => {
    const deps = makeDeps({
      runApps: vi.fn(async () => { throw new PromptCancelled(); }),
    });
    const code = await run(args('init'), deps);
    expect(code).toBe(130);
  });

  it('prints a "saved progress" message on cancellation', async () => {
    const deps = makeDeps({
      runPreamble: vi.fn(async () => { throw new PromptCancelled(); }),
    });
    await run(args('init'), deps);
    expect(deps.io.output()).toContain('Saved progress');
  });

  it('prints resume command hint on cancellation', async () => {
    const deps = makeDeps({
      runPreamble: vi.fn(async () => { throw new PromptCancelled(); }),
    });
    await run(args('init'), deps);
    expect(deps.io.output()).toContain('agentify-setup resume');
  });
});

// ── Generic error handling ────────────────────────────────────────────────────

describe('run — error path', () => {
  it('returns 1 when preamble throws a generic error', async () => {
    const deps = makeDeps({
      runPreamble: vi.fn(async () => { throw new Error('boom'); }),
    });
    const code = await run(args('init'), deps);
    expect(code).toBe(1);
  });

  it('returns 1 when apps phase throws a generic error', async () => {
    const deps = makeDeps({
      runApps: vi.fn(async () => { throw new Error('apps failed'); }),
    });
    const code = await run(args('init'), deps);
    expect(code).toBe(1);
  });

  it('prints the error message on failure', async () => {
    const deps = makeDeps({
      runPreamble: vi.fn(async () => { throw new Error('something broke'); }),
    });
    await run(args('init'), deps);
    expect(deps.io.output()).toContain('something broke');
  });

  it('prints the state file path when a prefix is known', async () => {
    const deps = makeDeps({
      // preamble succeeds; apps fails after state is built
      runApps: vi.fn(async () => { throw new Error('apps exploded'); }),
    });
    await run(args('init'), deps);
    // State file path should contain the prefix from preamble result
    expect(deps.io.output()).toContain('test-prefix');
  });
});

// ── state checkpointing ───────────────────────────────────────────────────────

describe('run — state checkpointing', () => {
  it('does not call saveState when preamble fails', async () => {
    const deps = makeDeps({
      runPreamble: vi.fn(async () => { throw new Error('preamble failed'); }),
    });
    await run(args('init'), deps);
    expect(deps.saveState).not.toHaveBeenCalled();
  });

  it('saves once after preamble even when apps fails', async () => {
    const deps = makeDeps({
      runApps: vi.fn(async () => { throw new Error('apps failed'); }),
    });
    await run(args('init'), deps);
    // One save (after preamble), then error in apps
    expect(deps.saveState).toHaveBeenCalledTimes(1);
  });

  it('passes stateOpts with correct dir when --state-file is set', async () => {
    const saveOpts: Array<{ dir?: string } | undefined> = [];
    const deps = makeDeps({
      saveState: vi.fn(async (_state: WizardState, opts?: { dir?: string }) => {
        saveOpts.push(opts);
      }),
    });
    await run(args('init', { stateFile: '/tmp/custom/setup.json' }), deps);
    // All saves should use /tmp/custom as the dir
    for (const opt of saveOpts) {
      expect(opt?.dir).toBe('/tmp/custom');
    }
  });
});
