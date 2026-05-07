import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { type IoStreams } from './prompts.js';
import {
  WizardStateSchema,
  PersonaCredsSchema,
  loadState,
  saveState,
  clearState,
  stateForSave,
  decryptStateOnLoad,
  type WizardState,
  type PersonaCreds,
} from './state.js';
import { type EncryptedValue, EncryptedValueSchema, DecryptError } from './crypto.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SAMPLE_CREDS: PersonaCreds = {
  appId: 12345,
  slug: 'my-prefix-orchestrator',
  name: 'My Prefix Orchestrator',
  htmlUrl: 'https://github.com/apps/my-prefix-orchestrator',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
  clientId: 'Iv1.abc12345678',
  clientSecret: 's3cr3t',
  webhookSecret: 'wh-secret',
  installationId: 78901,
  githubUser: 'my-prefix-orchestrator[bot]',
};

const MINIMAL_STATE: WizardState = {
  version: 2,
  prefix: 'my-prefix',
  repo: { owner: 'alice', name: 'sandbox' },
  ownerType: 'personal',
  coordinator: undefined,
  personas: {},
  anthropic: undefined,
  tunables: undefined,
};

const FULL_STATE: WizardState = {
  version: 2,
  prefix: 'my-prefix',
  repo: {
    owner: 'alice',
    name: 'sandbox',
    ownerId: 1001,
    repoId: 9999,
  },
  ownerType: 'organization',
  coordinator: SAMPLE_CREDS,
  personas: {
    orchestrator: SAMPLE_CREDS,
    conductor: { ...SAMPLE_CREDS, slug: 'my-prefix-conductor', appId: 22222 },
  },
  anthropic: undefined,
  tunables: { LOG_LEVEL: 'debug', MAX_RETRIES: 3 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agentify-state-test-'));
}

// ── WizardStateSchema — basic validation ──────────────────────────────────────

describe('WizardStateSchema', () => {
  it('accepts a minimal valid state (no coordinator, empty personas)', () => {
    const result = WizardStateSchema.safeParse(MINIMAL_STATE);
    expect(result.success).toBe(true);
  });

  it('accepts a full valid state with coordinator, partial personas, tunables', () => {
    const result = WizardStateSchema.safeParse(FULL_STATE);
    expect(result.success).toBe(true);
  });

  it('rejects state with version: 1', () => {
    const result = WizardStateSchema.safeParse({ ...MINIMAL_STATE, version: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects state missing required prefix', () => {
    const { prefix: _prefix, ...rest } = MINIMAL_STATE;
    const result = WizardStateSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects state with unknown ownerType', () => {
    const result = WizardStateSchema.safeParse({
      ...MINIMAL_STATE,
      ownerType: 'enterprise',
    });
    expect(result.success).toBe(false);
  });
});

describe('PersonaCredsSchema', () => {
  it('accepts a valid PersonaCreds object', () => {
    const result = PersonaCredsSchema.safeParse(SAMPLE_CREDS);
    expect(result.success).toBe(true);
  });

  it('accepts null webhookSecret', () => {
    const result = PersonaCredsSchema.safeParse({
      ...SAMPLE_CREDS,
      webhookSecret: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative appId', () => {
    const result = PersonaCredsSchema.safeParse({ ...SAMPLE_CREDS, appId: -1 });
    expect(result.success).toBe(false);
  });
});

// ── EncryptedValue union — pem / clientSecret / webhookSecret ─────────────────

/** A minimal valid EncryptedValue fixture (shape only; not real ciphertext). */
const SAMPLE_ENCRYPTED: EncryptedValue = {
  version: 2,
  iv: Buffer.alloc(12).toString('base64'),
  salt: Buffer.alloc(32).toString('base64'),
  tag: Buffer.alloc(16).toString('base64'),
  ciphertext: Buffer.from('opaque').toString('base64'),
};

describe('PersonaCredsSchema — EncryptedValue unions', () => {
  it('accepts pem as a plaintext string', () => {
    // SAMPLE_CREDS already has a plaintext pem; verify the union accepts it.
    const result = PersonaCredsSchema.safeParse(SAMPLE_CREDS);
    expect(result.success).toBe(true);
  });

  it('accepts pem as an EncryptedValue', () => {
    const result = PersonaCredsSchema.safeParse({
      ...SAMPLE_CREDS,
      pem: SAMPLE_ENCRYPTED,
    });
    expect(result.success).toBe(true);
  });

  it('accepts clientSecret as an EncryptedValue', () => {
    const result = PersonaCredsSchema.safeParse({
      ...SAMPLE_CREDS,
      clientSecret: SAMPLE_ENCRYPTED,
    });
    expect(result.success).toBe(true);
  });

  it('accepts webhookSecret as an EncryptedValue', () => {
    const result = PersonaCredsSchema.safeParse({
      ...SAMPLE_CREDS,
      webhookSecret: SAMPLE_ENCRYPTED,
    });
    expect(result.success).toBe(true);
  });

  it('accepts clientSecret and webhookSecret both as EncryptedValue', () => {
    const result = PersonaCredsSchema.safeParse({
      ...SAMPLE_CREDS,
      clientSecret: SAMPLE_ENCRYPTED,
      webhookSecret: SAMPLE_ENCRYPTED,
    });
    expect(result.success).toBe(true);
  });

  it('accepts webhookSecret as null even when other secrets are EncryptedValue', () => {
    const result = PersonaCredsSchema.safeParse({
      ...SAMPLE_CREDS,
      pem: SAMPLE_ENCRYPTED,
      clientSecret: SAMPLE_ENCRYPTED,
      webhookSecret: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects EncryptedValue with version other than 2', () => {
    const badEncrypted = { ...SAMPLE_ENCRYPTED, version: 1 };
    const result = PersonaCredsSchema.safeParse({
      ...SAMPLE_CREDS,
      pem: badEncrypted,
    });
    expect(result.success).toBe(false);
  });
});

// ── Round-trip ────────────────────────────────────────────────────────────────

describe('saveState + loadState — round-trip', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a minimal state (no coordinator, empty personas)', async () => {
    await saveState(MINIMAL_STATE, { dir: tmpDir });
    const loaded = await loadState(MINIMAL_STATE.prefix, { dir: tmpDir });
    expect(loaded).toEqual(MINIMAL_STATE);
  });

  it('round-trips a full state (coordinator, partial personas, tunables)', async () => {
    await saveState(FULL_STATE, { dir: tmpDir });
    const loaded = await loadState(FULL_STATE.prefix, { dir: tmpDir });
    expect(loaded).toEqual(FULL_STATE);
  });

  it('preserves numeric IDs (not coerced to strings)', async () => {
    await saveState(FULL_STATE, { dir: tmpDir });
    const loaded = await loadState(FULL_STATE.prefix, { dir: tmpDir });
    expect(typeof loaded?.coordinator?.appId).toBe('number');
    expect(typeof loaded?.coordinator?.installationId).toBe('number');
  });

  it('preserves null webhookSecret', async () => {
    const state: WizardState = {
      ...MINIMAL_STATE,
      coordinator: { ...SAMPLE_CREDS, webhookSecret: null },
    };
    await saveState(state, { dir: tmpDir });
    const loaded = await loadState(state.prefix, { dir: tmpDir });
    expect(loaded?.coordinator?.webhookSecret).toBeNull();
  });

  it('overwrites an existing file', async () => {
    await saveState(MINIMAL_STATE, { dir: tmpDir });

    const updated: WizardState = {
      ...MINIMAL_STATE,
      coordinator: SAMPLE_CREDS,
    };
    await saveState(updated, { dir: tmpDir });

    const loaded = await loadState(MINIMAL_STATE.prefix, { dir: tmpDir });
    expect(loaded?.coordinator).toEqual(SAMPLE_CREDS);
  });

  it('creates the parent directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'dir');
    await saveState(MINIMAL_STATE, { dir: nested });
    const loaded = await loadState(MINIMAL_STATE.prefix, { dir: nested });
    expect(loaded?.prefix).toBe(MINIMAL_STATE.prefix);
  });
});

// ── loadState — missing file ──────────────────────────────────────────────────

describe('loadState — missing file', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the state file does not exist', async () => {
    const result = await loadState('nonexistent-prefix', { dir: tmpDir });
    expect(result).toBeNull();
  });

  it('returns null for a different prefix than the one saved', async () => {
    await saveState(MINIMAL_STATE, { dir: tmpDir });
    const result = await loadState('different-prefix', { dir: tmpDir });
    expect(result).toBeNull();
  });
});

// ── loadState — malformed file ────────────────────────────────────────────────

describe('loadState — malformed file', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws when the file contains invalid JSON', async () => {
    const filePath = path.join(tmpDir, 'setup-bad.json');
    await fs.writeFile(filePath, '{not valid json}', 'utf8');

    await expect(loadState('bad', { dir: tmpDir })).rejects.toThrow(
      filePath,
    );
  });

  it('throws when the file JSON does not satisfy the schema', async () => {
    const filePath = path.join(tmpDir, 'setup-invalid.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 99, unexpected: true }),
      'utf8',
    );

    await expect(loadState('invalid', { dir: tmpDir })).rejects.toThrow(
      filePath,
    );
  });

  it('does NOT silently overwrite a malformed file (throws instead)', async () => {
    const filePath = path.join(tmpDir, 'setup-corrupt.json');
    await fs.writeFile(filePath, 'totally-not-json', 'utf8');

    let threw = false;
    try {
      await loadState('corrupt', { dir: tmpDir });
    } catch {
      threw = true;
    }

    // Ensure the original corrupt file is still there (not overwritten).
    const stillThere = await fs.readFile(filePath, 'utf8');
    expect(stillThere).toBe('totally-not-json');
    expect(threw).toBe(true);
  });
});

// ── saveState — file mode ─────────────────────────────────────────────────────

describe('saveState — file mode 0o600', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('sets mode 0o600 on the written file (skip on win32)', async () => {
    if (process.platform === 'win32') return;

    await saveState(MINIMAL_STATE, { dir: tmpDir });
    const filePath = path.join(tmpDir, 'setup-my-prefix.json');
    const stat = await fs.stat(filePath);
    // Mask to the permission bits only (lower 9 bits).
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ── clearState ────────────────────────────────────────────────────────────────

describe('clearState', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('removes the state file', async () => {
    await saveState(MINIMAL_STATE, { dir: tmpDir });
    await clearState(MINIMAL_STATE.prefix, { dir: tmpDir });

    const result = await loadState(MINIMAL_STATE.prefix, { dir: tmpDir });
    expect(result).toBeNull();
  });

  it('does not throw when the file does not exist', async () => {
    await expect(
      clearState('ghost-prefix', { dir: tmpDir }),
    ).resolves.toBeUndefined();
  });

  it('only removes the file for the specified prefix', async () => {
    const stateA: WizardState = { ...MINIMAL_STATE, prefix: 'prefix-a' };
    const stateB: WizardState = { ...MINIMAL_STATE, prefix: 'prefix-b' };
    await saveState(stateA, { dir: tmpDir });
    await saveState(stateB, { dir: tmpDir });

    await clearState('prefix-a', { dir: tmpDir });

    expect(await loadState('prefix-a', { dir: tmpDir })).toBeNull();
    expect(await loadState('prefix-b', { dir: tmpDir })).toEqual(stateB);
  });
});

// ── V1 → V2 migration ────────────────────────────────────────────────────────

/**
 * A minimal v1 state fixture (plaintext PEMs, version: 1).
 * Constructed explicitly so it survives future bumps to WizardStateSchema.
 */
const V1_FIXTURE = {
  version: 1,
  prefix: 'v1-test',
  repo: { owner: 'alice', name: 'sandbox' },
  ownerType: 'personal',
  coordinator: {
    appId: 1,
    slug: 'v1-test-orchestrator',
    name: 'V1 Test Orchestrator',
    htmlUrl: 'https://github.com/apps/v1-test-orchestrator',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
    clientId: 'Iv1.abc12345678',
    clientSecret: 's3cr3t',
    webhookSecret: 'wh-secret',
    installationId: 78901,
    githubUser: 'v1-test-orchestrator[bot]',
  },
  personas: {},
};

/**
 * A comprehensive v1 state fixture (plaintext PEMs, version: 1) with both
 * orchestrator and conductor personas, as well as coordinator credentials.
 *
 * Inlined as a literal so the test clearly documents what v1 looked like and
 * is robust to future v2 schema bumps (does not derive from MINIMAL_STATE /
 * FULL_STATE, which are v2 shapes).
 */
const V1_FULL_FIXTURE = {
  version: 1,
  prefix: 'mig-test',
  repo: { owner: 'a', name: 'b' },
  ownerType: 'personal',
  coordinator: {
    appId: 100,
    slug: 'mig-test-coordinator',
    name: 'Mig Test Coordinator',
    htmlUrl: 'https://github.com/apps/mig-test-coordinator',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowCoordinator...\n-----END RSA PRIVATE KEY-----\n',
    clientId: 'Iv1.coord001',
    clientSecret: 'coord-secret-v1',
    webhookSecret: 'coord-webhook-v1',
    installationId: 11111,
    githubUser: 'mig-test-coordinator[bot]',
  },
  personas: {
    orchestrator: {
      appId: 200,
      slug: 'mig-test-orchestrator',
      name: 'Mig Test Orchestrator',
      htmlUrl: 'https://github.com/apps/mig-test-orchestrator',
      pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowOrchestrator...\n-----END RSA PRIVATE KEY-----\n',
      clientId: 'Iv1.orch001',
      clientSecret: 'orch-secret-v1',
      webhookSecret: 'orch-webhook-v1',
      installationId: 22222,
      githubUser: 'mig-test-orchestrator[bot]',
    },
    conductor: {
      appId: 300,
      slug: 'mig-test-conductor',
      name: 'Mig Test Conductor',
      htmlUrl: 'https://github.com/apps/mig-test-conductor',
      pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowConductor...\n-----END RSA PRIVATE KEY-----\n',
      clientId: 'Iv1.cond001',
      clientSecret: 'cond-secret-v1',
      webhookSecret: 'cond-webhook-v1',
      installationId: 33333,
      githubUser: 'mig-test-conductor[bot]',
    },
  },
};

describe('loadState — v1 → v2 migration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('migrates a v1 state file on load: returns v2 in-memory state with plaintext PEMs', async () => {
    // Write a v1 fixture to disk.
    const filePath = path.join(tmpDir, 'setup-v1-test.json');
    await fs.writeFile(filePath, JSON.stringify(V1_FIXTURE), 'utf8');

    const loaded = await loadState('v1-test', {
      dir: tmpDir,
      passphrase: 'super-secret-passphrase',
    });

    // The caller receives version 2 with plaintext PEMs.
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(2);
    expect(typeof loaded?.coordinator?.pem).toBe('string');
    expect(loaded?.coordinator?.pem).toContain('-----BEGIN');
    expect(typeof loaded?.coordinator?.clientSecret).toBe('string');
    expect(loaded?.coordinator?.clientSecret).toBe('s3cr3t');

    // The file on disk must now be v2 with encrypted (not plaintext) PEMs.
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk['version']).toBe(2);
    const coord = onDisk['coordinator'] as Record<string, unknown>;
    // pem field should be an EncryptedValue object, not a plain string.
    expect(typeof coord['pem']).toBe('object');
    expect((coord['pem'] as Record<string, unknown>)['version']).toBe(2);
    // No plaintext PEM bytes on disk.
    const diskJson = await fs.readFile(filePath, 'utf8');
    expect(diskJson).not.toContain('-----BEGIN');
  });

  it('throws a clear error when a v1 state file is loaded without a passphrase', async () => {
    // Write a v1 fixture to disk.
    const filePath = path.join(tmpDir, 'setup-v1-test.json');
    await fs.writeFile(filePath, JSON.stringify(V1_FIXTURE), 'utf8');

    await expect(loadState('v1-test', { dir: tmpDir })).rejects.toThrow(
      /version 1.*passphrase|AGENTIFY_SETUP_PASSPHRASE/i,
    );

    // The original v1 file must be untouched.
    const stillV1 = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(stillV1['version']).toBe(1);
  });

  // ── Full round-trip tests using the comprehensive V1_FULL_FIXTURE ──────────

  it('migrates a v1 file in place and returns plaintext state', async () => {
    // Write a realistic v1 fixture with coordinator + two personas — directly
    // (not through saveState) so we get a genuine v1 file on disk.
    const filePath = path.join(tmpDir, 'setup-mig-test.json');
    await fs.writeFile(filePath, JSON.stringify(V1_FULL_FIXTURE), 'utf8');

    const loaded = await loadState('mig-test', {
      dir: tmpDir,
      passphrase: 'migration-test-12c',
    });

    // ── In-memory return: version 2, plaintext credentials ─────────────────
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(2);

    // Coordinator — plaintext in memory.
    expect(typeof loaded?.coordinator?.pem).toBe('string');
    expect(loaded?.coordinator?.pem).toContain('-----BEGIN');
    expect(loaded?.coordinator?.clientSecret).toBe('coord-secret-v1');
    expect(loaded?.coordinator?.webhookSecret).toBe('coord-webhook-v1');

    // Orchestrator persona — plaintext in memory.
    expect(typeof loaded?.personas?.orchestrator?.pem).toBe('string');
    expect(loaded?.personas?.orchestrator?.pem).toContain('-----BEGIN');
    expect(loaded?.personas?.orchestrator?.clientSecret).toBe('orch-secret-v1');
    expect(loaded?.personas?.orchestrator?.webhookSecret).toBe('orch-webhook-v1');

    // Conductor persona — plaintext in memory.
    expect(typeof loaded?.personas?.conductor?.pem).toBe('string');
    expect(loaded?.personas?.conductor?.pem).toContain('-----BEGIN');
    expect(loaded?.personas?.conductor?.clientSecret).toBe('cond-secret-v1');
    expect(loaded?.personas?.conductor?.webhookSecret).toBe('cond-webhook-v1');

    // ── On-disk file: version 2, all sensitive fields encrypted ───────────
    const diskJson = await fs.readFile(filePath, 'utf8');
    const onDisk = JSON.parse(diskJson) as Record<string, unknown>;

    expect(onDisk['version']).toBe(2);

    // Coordinator on-disk: pem, clientSecret, webhookSecret are EncryptedValue.
    const coord = onDisk['coordinator'] as Record<string, unknown>;
    expect(EncryptedValueSchema.safeParse(coord['pem']).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(coord['clientSecret']).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(coord['webhookSecret']).success).toBe(true);

    // Personas on-disk: pem, clientSecret, webhookSecret are EncryptedValue.
    const personas = onDisk['personas'] as Record<string, Record<string, unknown>>;

    expect(EncryptedValueSchema.safeParse(personas['orchestrator']?.['pem']).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(personas['orchestrator']?.['clientSecret']).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(personas['orchestrator']?.['webhookSecret']).success).toBe(true);

    expect(EncryptedValueSchema.safeParse(personas['conductor']?.['pem']).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(personas['conductor']?.['clientSecret']).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(personas['conductor']?.['webhookSecret']).success).toBe(true);

    // No plaintext PEM bytes present anywhere in the serialised file.
    expect(diskJson).not.toContain('-----BEGIN');

    // ── Round-trip: load the migrated (v2) file a second time ─────────────
    // The second load must decrypt and return the same plaintext credentials.
    const reloaded = await loadState('mig-test', {
      dir: tmpDir,
      passphrase: 'migration-test-12c',
    });
    expect(reloaded).not.toBeNull();
    expect(reloaded?.version).toBe(2);
    expect(reloaded?.coordinator?.pem).toBe(loaded?.coordinator?.pem);
    expect(reloaded?.coordinator?.clientSecret).toBe('coord-secret-v1');
    expect(reloaded?.coordinator?.webhookSecret).toBe('coord-webhook-v1');
    expect(reloaded?.personas?.orchestrator?.pem).toBe(loaded?.personas?.orchestrator?.pem);
    expect(reloaded?.personas?.orchestrator?.clientSecret).toBe('orch-secret-v1');
    expect(reloaded?.personas?.conductor?.pem).toBe(loaded?.personas?.conductor?.pem);
    expect(reloaded?.personas?.conductor?.clientSecret).toBe('cond-secret-v1');
  });

  it('refuses to migrate a v1 file without a passphrase', async () => {
    // Write the comprehensive v1 fixture to disk directly (not via saveState).
    const filePath = path.join(tmpDir, 'setup-mig-test.json');
    const originalContent = JSON.stringify(V1_FULL_FIXTURE);
    await fs.writeFile(filePath, originalContent, 'utf8');

    // loadState without a passphrase must throw a clear, informative error.
    await expect(loadState('mig-test', { dir: tmpDir })).rejects.toThrow(
      /version 1.*passphrase|AGENTIFY_SETUP_PASSPHRASE/i,
    );

    // The original v1 file must be completely unchanged — no partial migration.
    const afterAttempt = await fs.readFile(filePath, 'utf8');
    expect(JSON.parse(afterAttempt)['version']).toBe(1);
    expect(afterAttempt).toContain('-----BEGIN'); // plaintext PEMs still there
  });

  it('emits a one-time migration notice on first load and not on subsequent loads', async () => {
    /** Build a PassThrough-based IoStreams pair that captures stdout. */
    function makeTestIo(): IoStreams & { output: () => string } {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const chunks: Buffer[] = [];
      stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      return { stdin, stdout, output: () => Buffer.concat(chunks).toString('utf8') };
    }

    // Write the v1 fixture.
    const filePath = path.join(tmpDir, 'setup-mig-test.json');
    await fs.writeFile(filePath, JSON.stringify(V1_FULL_FIXTURE), 'utf8');

    // First load — must emit the migration notice once.
    const io1 = makeTestIo();
    await loadState('mig-test', {
      dir: tmpDir,
      passphrase: 'migration-test-12c',
      io: io1,
    });
    expect(io1.output()).toContain('Migrated state file from v1 to v2');

    // Second load — the file is already v2; migration notice must NOT be repeated.
    const io2 = makeTestIo();
    await loadState('mig-test', {
      dir: tmpDir,
      passphrase: 'migration-test-12c',
      io: io2,
    });
    expect(io2.output()).not.toContain('Migrated state file from v1 to v2');
  });
});

// ── Concurrent save ───────────────────────────────────────────────────────────

describe('concurrent saveState calls', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('both writes complete without error when concurrent saves race', async () => {
    const stateA: WizardState = { ...MINIMAL_STATE, prefix: 'race' };
    const stateB: WizardState = {
      ...MINIMAL_STATE,
      prefix: 'race',
      coordinator: SAMPLE_CREDS,
    };

    // Fire both saves simultaneously.
    await expect(
      Promise.all([
        saveState(stateA, { dir: tmpDir }),
        saveState(stateB, { dir: tmpDir }),
      ]),
    ).resolves.toBeDefined();

    // The file must be readable and valid after both writes complete.
    const final = await loadState('race', { dir: tmpDir });
    expect(final).not.toBeNull();
    expect(final?.prefix).toBe('race');
  });
});

// ── stateForSave + decryptStateOnLoad — encryption surface ────────────────────

describe('stateForSave + decryptStateOnLoad — encryption surface', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trip: stateForSave encrypts then decryptStateOnLoad recovers credentials', () => {
    const encrypted = stateForSave(FULL_STATE, 'test-pass-12chars');

    // All three sensitive fields on coordinator must be EncryptedValue objects.
    expect(EncryptedValueSchema.safeParse(encrypted.coordinator!.pem).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(encrypted.coordinator!.clientSecret).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(encrypted.coordinator!.webhookSecret).success).toBe(true);

    // Same for every populated persona.
    for (const creds of Object.values(encrypted.personas)) {
      if (!creds) continue;
      expect(EncryptedValueSchema.safeParse(creds.pem).success).toBe(true);
      expect(EncryptedValueSchema.safeParse(creds.clientSecret).success).toBe(true);
      expect(EncryptedValueSchema.safeParse(creds.webhookSecret).success).toBe(true);
    }

    // Decrypt and verify every plaintext credential is recovered.
    const decrypted = decryptStateOnLoad(encrypted, 'test-pass-12chars');
    expect(decrypted.coordinator!.pem).toBe(SAMPLE_CREDS.pem);
    expect(decrypted.coordinator!.clientSecret).toBe(SAMPLE_CREDS.clientSecret);
    expect(decrypted.coordinator!.webhookSecret).toBe(SAMPLE_CREDS.webhookSecret);
  });

  it('loadState throws when state has encrypted fields but no passphrase is supplied', async () => {
    await saveState(stateForSave(FULL_STATE, 'test-pass-12chars'), { dir: tmpDir });

    const expectedPath = path.join(tmpDir, `setup-${FULL_STATE.prefix}.json`);
    await expect(loadState(FULL_STATE.prefix, { dir: tmpDir })).rejects.toThrow(/passphrase/);
    await expect(loadState(FULL_STATE.prefix, { dir: tmpDir })).rejects.toThrow(expectedPath);
  });

  it('stateForSave is idempotent: second pass leaves already-encrypted fields untouched', () => {
    const once = stateForSave(FULL_STATE, 'test-pass-12chars');
    const twice = stateForSave(once, 'test-pass-12chars');

    // Fields in `twice` must still be EncryptedValues, not double-encrypted.
    expect(EncryptedValueSchema.safeParse(twice.coordinator!.pem).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(twice.coordinator!.clientSecret).success).toBe(true);
    expect(EncryptedValueSchema.safeParse(twice.coordinator!.webhookSecret).success).toBe(true);

    // Decryption of `twice` must still recover the original plaintext credentials.
    const decrypted = decryptStateOnLoad(twice, 'test-pass-12chars');
    expect(decrypted.coordinator!.pem).toBe(SAMPLE_CREDS.pem);
    expect(decrypted.coordinator!.clientSecret).toBe(SAMPLE_CREDS.clientSecret);
    expect(decrypted.coordinator!.webhookSecret).toBe(SAMPLE_CREDS.webhookSecret);

    // The second pass must be a true no-op: both results are deeply equal.
    expect(twice).toEqual(once);
  });

  it('decryptStateOnLoad with wrong passphrase throws DecryptError', () => {
    // Sibling integration test in index.test.ts (issue #494) covers the same property through loadState.
    const encrypted = stateForSave(FULL_STATE, 'right-pass-12char');
    expect(() => decryptStateOnLoad(encrypted, 'wrong-pass-12char')).toThrow(DecryptError);
  });
});
