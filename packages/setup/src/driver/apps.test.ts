/**
 * apps.test.ts — unit tests for the per-persona App-creation loop driver.
 *
 * All I/O, network, and filesystem operations are injected via stubs so
 * no real browser, GitHub API, or disk writes are needed.
 */

import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { BUILTIN_PERSONAS } from '@agentify/shared';
import { runApps } from './apps.js';
import { PromptCancelled } from '../prompts.js';
import { CallbackTimeoutError } from '../callback-server.js';
import { InstallationTimeoutError } from '../install.js';
import { EncryptedValueSchema, decryptValue } from '../crypto.js';
import type { IoStreams } from '../prompts.js';
import type { WizardState, PersonaCreds } from '../state.js';
import type { ExchangedApp } from '../manifest-exchange.js';
import type { CallbackServerHandle } from '../callback-server.js';
import type { EncryptedValue } from '../crypto.js';

// ── Constants / fixtures ──────────────────────────────────────────────────────

const PERSONAS = BUILTIN_PERSONAS;
const PERSONA_COUNT = PERSONAS.length; // 9

/** Build a minimal WizardState with no personas completed. */
function makeState(overrides: Partial<WizardState> = {}): WizardState {
  return {
    version: 2,
    prefix: 'test-prefix',
    repo: { owner: 'alice', name: 'sandbox' },
    ownerType: 'personal',
    coordinator: undefined,
    personas: Object.fromEntries(PERSONAS.map((p) => [p, undefined])),
    anthropic: undefined,
    tunables: undefined,
    ...overrides,
  };
}

/** Build a minimal PersonaCreds fixture for persona at index n. */
function makeCreds(persona: string, n: number): PersonaCreds {
  return {
    appId: 1000 + n,
    slug: `test-prefix-${persona}`,
    name: `test-prefix-${persona}`,
    htmlUrl: `https://github.com/apps/test-prefix-${persona}`,
    pem: `-----BEGIN RSA PRIVATE KEY-----\nMOCK${n}\n-----END RSA PRIVATE KEY-----\n`,
    clientId: `Iv1.mock${n}`,
    clientSecret: `secret${n}`,
    webhookSecret: `hook${n}`,
    installationId: 2000 + n,
    githubUser: `test-prefix-${persona}[bot]`,
  };
}

/** Build a mock ExchangedApp for persona at index n. */
function makeExchanged(persona: string, n: number): ExchangedApp {
  return {
    id: 1000 + n,
    slug: `test-prefix-${persona}`,
    name: `test-prefix-${persona}`,
    htmlUrl: `https://github.com/apps/test-prefix-${persona}`,
    pem: `-----BEGIN RSA PRIVATE KEY-----\nMOCK${n}\n-----END RSA PRIVATE KEY-----\n`,
    clientId: `Iv1.mock${n}`,
    clientSecret: `secret${n}`,
    webhookSecret: `hook${n}`,
    ownerLogin: 'alice',
  };
}

// ── I/O helpers ───────────────────────────────────────────────────────────────

/**
 * Build an IoStreams pair fed by the given lines, one per tick.
 * Lines are written with chained setImmediate so each readline.Interface
 * is already listening when its line arrives.
 */
function makeIo(lines: string[] = []): IoStreams & { output: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const remaining = [...lines];
  function writeNext(): void {
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

// ── Stub helpers ──────────────────────────────────────────────────────────────

/** Build a mock CallbackServerHandle whose awaitCallback resolves by default. */
function makeCallbackServer(): {
  handle: CallbackServerHandle;
  stage: ReturnType<typeof vi.fn>;
  awaitCallback: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const stage = vi.fn();
  const awaitCallback = vi.fn((state: string) =>
    Promise.resolve({ code: `mock-code-${state}` }),
  );
  const close = vi.fn(() => Promise.resolve());

  const handle: CallbackServerHandle = {
    server: {} as CallbackServerHandle['server'],
    baseUrl: 'http://127.0.0.1:9999',
    stage,
    awaitCallback,
    close,
  };

  return { handle, stage, awaitCallback, close };
}

/** Build all AppsDeps with stubs pre-wired. */
function makeDeps(
  state: WizardState = makeState(),
  ioLines: string[] = [],
): {
  deps: ReturnType<typeof buildDeps>;
  server: ReturnType<typeof makeCallbackServer>;
  savedStates: WizardState[];
  openedUrls: string[];
  exchangeMock: ReturnType<typeof vi.fn>;
  installMock: ReturnType<typeof vi.fn>;
} {
  const server = makeCallbackServer();
  const openedUrls: string[] = [];
  const savedStates: WizardState[] = [];

  // Track call count independently to derive persona from order
  let exchangeCallIdx = 0;
  const exchangeMock = vi.fn((_code: string) => {
    const n = exchangeCallIdx;
    const persona = PERSONAS[n] ?? 'orchestrator';
    exchangeCallIdx++;
    return Promise.resolve(makeExchanged(persona, n));
  });

  let installCallIdx = 0;
  const installMock = vi.fn((_app: ExchangedApp, _repo: unknown) => {
    const n = installCallIdx;
    installCallIdx++;
    return Promise.resolve({ installationId: 2000 + n });
  });

  function buildDeps() {
    return {
      state,
      io: makeIo(ioLines),
      passphrase: 'test-passphrase-12chars',
      openInBrowser: async (url: string) => { openedUrls.push(url); },
      saveState: async (s: WizardState) => { savedStates.push(s); },
      callbackServerFactory: async () => server.handle,
      exchangeManifest: exchangeMock as (code: string) => Promise<ExchangedApp>,
      awaitInstallation: installMock as (
        app: ExchangedApp,
        repo: unknown,
      ) => Promise<{ installationId: number }>,
    };
  }

  const deps = buildDeps();
  return { deps, server, savedStates, openedUrls, exchangeMock, installMock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runApps — happy path', () => {
  it('processes all 9 personas in BUILTIN_PERSONAS order', async () => {
    const { deps, exchangeMock, installMock, savedStates } = makeDeps();
    const result = await runApps(deps);

    expect(exchangeMock).toHaveBeenCalledTimes(PERSONA_COUNT);
    expect(installMock).toHaveBeenCalledTimes(PERSONA_COUNT);
    expect(savedStates).toHaveLength(PERSONA_COUNT);

    const personas = result.personas as Record<string, PersonaCreds | undefined>;
    for (const p of PERSONAS) {
      expect(personas[p]).toBeDefined();
      expect(personas[p]?.githubUser).toBe(`test-prefix-${p}[bot]`);
    }
  });

  it('sets coordinator to the orchestrator (first persona) credentials', async () => {
    const { deps } = makeDeps();
    const result = await runApps(deps);

    const personas = result.personas as Record<string, PersonaCreds | undefined>;
    const orchestratorCreds = personas['orchestrator'];
    expect(result.coordinator).toBeDefined();
    expect(result.coordinator).toStrictEqual(orchestratorCreds);
  });

  it('closes the callback server after the loop', async () => {
    const { deps, server } = makeDeps();
    await runApps(deps);

    expect(server.close).toHaveBeenCalledOnce();
  });

  it('stages each persona on the server before opening the browser', async () => {
    const { deps, server } = makeDeps();
    await runApps(deps);

    expect(server.stage).toHaveBeenCalledTimes(PERSONA_COUNT);

    // Each call should use the correct persona name as the first argument
    for (let i = 0; i < PERSONA_COUNT; i++) {
      const [stagedPersona] = server.stage.mock.calls[i] as [string, string, string];
      expect(stagedPersona).toBe(PERSONAS[i]);
    }
  });

  it('opens start URL then install URL for each persona (2 opens per persona)', async () => {
    const { deps, openedUrls } = makeDeps();
    await runApps(deps);

    expect(openedUrls).toHaveLength(PERSONA_COUNT * 2);

    for (let i = 0; i < PERSONA_COUNT; i++) {
      const startUrl = openedUrls[i * 2]!;
      expect(startUrl).toContain('/start?persona=');
      expect(startUrl).toContain(PERSONAS[i]);
    }
  });

  it('checkpoints state after each persona', async () => {
    const { deps, savedStates } = makeDeps();
    await runApps(deps);

    expect(savedStates).toHaveLength(PERSONA_COUNT);

    // Each checkpoint should include the persona just created
    for (let i = 0; i < PERSONA_COUNT; i++) {
      const saved = savedStates[i]!;
      const persona = PERSONAS[i]!;
      expect(saved.personas[persona]).toBeDefined();
    }
  });

  it('sets coordinator in the first checkpoint (after orchestrator)', async () => {
    const { deps, savedStates } = makeDeps();
    await runApps(deps);

    const firstSave = savedStates[0]!;
    expect(firstSave.coordinator).toBeDefined();
    expect(firstSave.coordinator?.slug).toBe('test-prefix-orchestrator');
  });
});

describe('runApps — partial state resume', () => {
  it('skips personas that already have creds in state', async () => {
    const prefilledPersonas = Object.fromEntries(
      PERSONAS.map((p, i) => [p, i < 3 ? makeCreds(p, i) : undefined]),
    ) as WizardState['personas'];

    const state = makeState({ personas: prefilledPersonas });
    const { deps, exchangeMock, installMock } = makeDeps(state);
    await runApps(deps);

    expect(exchangeMock).toHaveBeenCalledTimes(PERSONA_COUNT - 3);
    expect(installMock).toHaveBeenCalledTimes(PERSONA_COUNT - 3);
  });

  it('includes pre-filled creds in the returned personas map', async () => {
    const prefilledPersonas = Object.fromEntries(
      PERSONAS.map((p, i) => [p, i < 3 ? makeCreds(p, i) : undefined]),
    ) as WizardState['personas'];

    const state = makeState({ personas: prefilledPersonas });
    const { deps } = makeDeps(state);
    const result = await runApps(deps);

    const personas = result.personas as Record<string, PersonaCreds | undefined>;
    for (let i = 0; i < 3; i++) {
      const p = PERSONAS[i]!;
      expect(personas[p]).toStrictEqual(makeCreds(p, i));
    }
    for (let i = 3; i < PERSONA_COUNT; i++) {
      expect(personas[PERSONAS[i]!]).toBeDefined();
    }
  });

  it('does nothing when every persona is already complete', async () => {
    const prefilledPersonas = Object.fromEntries(
      PERSONAS.map((p, i) => [p, makeCreds(p, i)]),
    ) as WizardState['personas'];

    const state = makeState({ personas: prefilledPersonas });
    const { deps, exchangeMock, installMock, savedStates } = makeDeps(state);
    await runApps(deps);

    expect(exchangeMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
    expect(savedStates).toHaveLength(0);
  });
});

describe('runApps — CallbackTimeoutError handling', () => {
  it('retries and succeeds when user chooses retry after callback timeout', async () => {
    let awaitCount = 0;
    const { deps, server, exchangeMock } = makeDeps(makeState(), ['1']); // '1' = retry

    server.awaitCallback.mockImplementation((_state: string) => {
      awaitCount++;
      if (awaitCount === 1) {
        return Promise.reject(new CallbackTimeoutError('test-state'));
      }
      return Promise.resolve({ code: `mock-code-${awaitCount}` });
    });

    const result = await runApps(deps);

    // awaitCallback called ≥ PERSONA_COUNT+1 (1 extra for the retry)
    expect(awaitCount).toBeGreaterThanOrEqual(PERSONA_COUNT + 1);
    // All personas complete
    expect(exchangeMock).toHaveBeenCalledTimes(PERSONA_COUNT);

    const personas = result.personas as Record<string, PersonaCreds | undefined>;
    for (const p of PERSONAS) {
      expect(personas[p]).toBeDefined();
    }
  });

  it('skips the persona when user chooses skip after callback timeout', async () => {
    const { deps, server } = makeDeps(makeState(), ['2']); // '2' = skip

    server.awaitCallback.mockRejectedValueOnce(
      new CallbackTimeoutError('test-state'),
    );

    const result = await runApps(deps);

    // orchestrator (first persona) should be skipped
    const personas = result.personas as Record<string, PersonaCreds | undefined>;
    expect(personas['orchestrator']).toBeUndefined();

    // All other 8 should complete
    for (const p of PERSONAS.slice(1)) {
      expect(personas[p]).toBeDefined();
    }
  });

  it('throws PromptCancelled when user aborts after callback timeout', async () => {
    const { deps, server } = makeDeps(makeState(), ['3']); // '3' = abort

    server.awaitCallback.mockRejectedValueOnce(
      new CallbackTimeoutError('test-state'),
    );

    await expect(runApps(deps)).rejects.toBeInstanceOf(PromptCancelled);
  });

  it('closes the server even when PromptCancelled is thrown', async () => {
    const { deps, server } = makeDeps(makeState(), ['3']); // abort

    server.awaitCallback.mockRejectedValueOnce(
      new CallbackTimeoutError('test-state'),
    );

    await expect(runApps(deps)).rejects.toBeInstanceOf(PromptCancelled);
    expect(server.close).toHaveBeenCalledOnce();
  });
});

describe('runApps — InstallationTimeoutError handling', () => {
  it('retries and succeeds when user chooses retry after install timeout', async () => {
    let installCount = 0;
    const { deps, installMock: _installMock } = makeDeps(makeState(), ['1']); // '1' = retry

    // Override the stub with a version that fails once
    deps.awaitInstallation = vi.fn((_app: ExchangedApp, _repo: unknown) => {
      installCount++;
      if (installCount === 1) {
        return Promise.reject(
          new InstallationTimeoutError('https://github.com/apps/test/install'),
        );
      }
      return Promise.resolve({ installationId: 7777 + installCount });
    });

    const result = await runApps(deps);

    expect(installCount).toBeGreaterThanOrEqual(PERSONA_COUNT + 1);

    const personas = result.personas as Record<string, PersonaCreds | undefined>;
    for (const p of PERSONAS) {
      expect(personas[p]).toBeDefined();
    }
  });

  it('skips persona when user chooses skip after install timeout', async () => {
    const { deps } = makeDeps(makeState(), ['2']); // '2' = skip

    let installCalled = false;
    let skipInstallCount = 0;
    deps.awaitInstallation = vi.fn((_app: ExchangedApp, _repo: unknown) => {
      skipInstallCount++;
      if (!installCalled) {
        installCalled = true;
        return Promise.reject(
          new InstallationTimeoutError('https://github.com/apps/test/install'),
        );
      }
      return Promise.resolve({ installationId: 2000 + skipInstallCount });
    });

    const result = await runApps(deps);

    // orchestrator skipped
    const personas = result.personas as Record<string, PersonaCreds | undefined>;
    expect(personas['orchestrator']).toBeUndefined();

    // Other 8 should complete
    for (const p of PERSONAS.slice(1)) {
      expect(personas[p]).toBeDefined();
    }
  });

  it('throws PromptCancelled when user aborts after install timeout', async () => {
    const { deps, server } = makeDeps(makeState(), ['3']); // '3' = abort

    deps.awaitInstallation = vi.fn(() =>
      Promise.reject(
        new InstallationTimeoutError('https://github.com/apps/test/install'),
      ),
    );

    await expect(runApps(deps)).rejects.toBeInstanceOf(PromptCancelled);
    expect(server.close).toHaveBeenCalledOnce();
  });
});

describe('runApps — single CallbackServer instance', () => {
  it('creates exactly one server regardless of persona count', async () => {
    let factoryCalls = 0;
    const { deps, server } = makeDeps();
    deps.callbackServerFactory = async () => {
      factoryCalls++;
      return server.handle;
    };

    await runApps(deps);

    expect(factoryCalls).toBe(1);
  });
});

describe('runApps — per-persona checkpoint sanitization', () => {
  it('does not persist anthropic secret in per-persona checkpoint saves (v1 policy)', async () => {
    // Even though anthropic is normally undefined during the apps phase, a
    // forward-compat guard is required: if for any reason the state passed to
    // runApps contains a populated anthropic field, each checkpoint must strip
    // it before persisting — exactly as the orchestrator top-level saves do in
    // index.ts (regression-test mirror of index.test.ts:209-224).
    const stateWithAnthropic = makeState({
      anthropic: { kind: 'api_key' as const, value: 'sk-ant-supersecret' },
    });

    const { deps, savedStates } = makeDeps(stateWithAnthropic);

    await runApps(deps);

    // Every checkpoint written by saveFn must have anthropic === undefined.
    expect(savedStates.length).toBeGreaterThan(0);
    for (const s of savedStates) {
      expect(s.anthropic).toBeUndefined();
    }
  });
});

describe('runApps — per-persona checkpoint encryption', () => {
  it('per-persona checkpoint state has encrypted pem bytes', async () => {
    // Run the full happy path (all 9 personas) and inspect the FIRST checkpoint.
    // The first checkpoint is written immediately after the orchestrator persona
    // completes, so only orchestrator has creds at that point — keeping
    // the number of scrypt operations to a minimum (3 fields × 1 persona).
    const { deps, savedStates, exchangeMock } = makeDeps();

    await runApps(deps);

    // 9 checkpoints total (one per persona).
    expect(savedStates.length).toBe(PERSONA_COUNT);

    // Inspect the first checkpoint (orchestrator persona).
    const firstSaved = savedStates[0]!;
    const orchestratorCreds = firstSaved.personas['orchestrator'];
    expect(orchestratorCreds).toBeDefined();

    // The pem field in the checkpoint must be an EncryptedValue, not a plaintext string.
    const encryptedPem = orchestratorCreds!.pem;
    expect(EncryptedValueSchema.safeParse(encryptedPem).success).toBe(true);
    expect(typeof encryptedPem).not.toBe('string');

    // Belt-and-braces: the raw JSON of the first checkpoint must not contain any
    // plaintext PEM material (no '-----BEGIN' substring anywhere in the persisted blob).
    expect(JSON.stringify(firstSaved)).not.toContain('-----BEGIN');

    // Decrypt the captured ciphertext and verify it round-trips back to the
    // original PEM that the exchange stub returned for the first (orchestrator) call.
    const firstExchangeResult = await (exchangeMock.mock.results[0]!.value as Promise<{ pem: string }>);
    const originalPem = firstExchangeResult.pem;
    const decrypted = decryptValue(encryptedPem as EncryptedValue, 'test-passphrase-12chars');
    expect(decrypted).toBe(originalPem);
  });
});
