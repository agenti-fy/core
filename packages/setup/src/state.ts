/**
 * state.ts — resumable wizard state store.
 *
 * State is persisted under the XDG config directory so that any abort
 * (Ctrl-C, browser closed, network drop) can be recovered without redoing
 * completed browser hand-offs.  Writes are atomic: the file is serialised to
 * a sibling `.tmp` path and then renamed into place, so a crash mid-write
 * leaves the previous file intact.
 *
 * File path: `<dir>/setup-<prefix>.json`
 * Default dir: `~/.config/agentify`
 * File mode: 0o600 (owner read/write only)
 * Dir mode: 0o700 (owner only, created on first save)
 */

import * as fs from 'node:fs/promises';
import { renameSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { BUILTIN_PERSONAS } from '@agentify/shared';
import {
  encryptValue,
  decryptValue,
  EncryptedValueSchema,
  type EncryptedValue,
} from './crypto.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

function defaultDir(): string {
  return path.join(os.homedir(), '.config', 'agentify');
}

function statePath(prefix: string, dir: string): string {
  return path.join(dir, `setup-${prefix}.json`);
}

function tmpPath(filePath: string): string {
  // Use a unique suffix per invocation so concurrent saves don't clobber each
  // other's tmp file before the rename.  Each rename(2) is still atomic — the
  // last writer wins, and all callers complete without error.
  const uid = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  return `${filePath}.${uid}.tmp`;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

/**
 * Credentials captured for one GitHub App (coordinator or a persona App)
 * after both manifest exchange and installation polling have completed.
 *
 * Field names mirror {@link ExchangedApp} from `manifest-exchange.ts` plus
 * the `installationId` and `githubUser` collected in the driver layer.
 * Numeric IDs are stored as numbers (not the string form used in .env).
 */
export const PersonaCredsSchema = z.object({
  /** Numeric GitHub App ID */
  appId: z.number().int().positive(),
  /** URL-safe slug (e.g. "my-prefix-orchestrator") */
  slug: z.string().min(1),
  /** Display name of the App */
  name: z.string().min(1),
  /** App HTML URL (e.g. "https://github.com/apps/my-app") */
  htmlUrl: z.string().min(1),
  /** PEM-encoded private key with real (not escaped) newlines, or encrypted form on disk */
  pem: z.union([z.string().min(1), EncryptedValueSchema]),
  /** OAuth client ID */
  clientId: z.string().min(1),
  /** OAuth client secret, or encrypted form on disk */
  clientSecret: z.union([z.string().min(1), EncryptedValueSchema]),
  /** Webhook secret from the manifest exchange, or null if absent, or encrypted form on disk */
  webhookSecret: z.union([z.string(), EncryptedValueSchema]).nullable(),
  /** Numeric installation ID on the target repo */
  installationId: z.number().int().positive(),
  /** GitHub bot user login (e.g. "my-prefix-orchestrator[bot]") */
  githubUser: z.string().min(1),
});

export type PersonaCreds = z.infer<typeof PersonaCredsSchema>;

/**
 * Anthropic credentials.  The issue notes that v1 always omits this from the
 * state file (long-lived secret rarely worth checkpointing); the field is
 * present in the schema so future opt-in logic has a home.
 */
const AnthropicCredsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api_key'), value: z.string().min(1) }),
  z.object({ kind: z.literal('oauth_token'), value: z.string().min(1) }),
]);

/** Free-form tunable overrides forwarded verbatim to the .env renderer. */
const TunablesSchema = z
  .record(z.string(), z.union([z.string(), z.number()]).optional())
  .optional();

/** Partial map of persona name → captured credentials (populated as each App is created & installed). */
const PersonasSchema = z.object(
  Object.fromEntries(
    BUILTIN_PERSONAS.map((p) => [p, PersonaCredsSchema.optional()]),
  ) as {
    [K in (typeof BUILTIN_PERSONAS)[number]]: z.ZodOptional<
      typeof PersonaCredsSchema
    >;
  },
);

/**
 * Top-level wizard state schema.
 *
 * `version` is the forward-compatibility hook: bump it whenever the shape
 * changes and add a migration branch in `loadState`.  V1 files (plaintext PEMs)
 * are migrated on load — see #492 (V1 → V2 migration on load) for that logic.
 */
export const WizardStateSchema = z.object({
  /**
   * Schema version — always 2 for files written by this module.
   * V1 files are migrated on load — see #492.
   */
  version: z.literal(2),
  /** Operator-supplied prefix used to name Apps (e.g. "agentify-alice"). */
  prefix: z.string().min(1),
  /**
   * Target GitHub repo.  `ownerId` and `repoId` are numeric GitHub IDs that,
   * when present, enable pre-selection on the App installation page.
   */
  repo: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
    ownerId: z.number().int().optional(),
    repoId: z.number().int().optional(),
  }),
  /** Whether the repo owner is a personal account or an organisation. */
  ownerType: z.enum(['personal', 'organization']),
  /**
   * Coordinator App credentials.  The coordinator service polls GitHub using a
   * separate App (not tied to a single persona).  Absent until the coordinator
   * App creation + installation step has completed.
   */
  coordinator: PersonaCredsSchema.optional(),
  /**
   * Per-persona App credentials.  A persona key is present once its App has
   * been created and installed; absent keys indicate steps still to be done.
   */
  personas: PersonasSchema,
  /**
   * Anthropic credentials.  Optional — v1 always omits this from the state
   * file (long-lived secret); the field is available for future opt-in logic.
   */
  anthropic: AnthropicCredsSchema.optional(),
  /** Optional tunable overrides (LOG_LEVEL, MODEL_NAME, …). */
  tunables: TunablesSchema,
});

/** In-progress wizard state persisted between runs. */
export type WizardState = z.infer<typeof WizardStateSchema>;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Strip long-lived secrets and encrypt sensitive fields before writing state to
 * disk.
 *
 * Always strips `anthropic.value` (v1 policy: #426/#430) — the finalize phase
 * uses the in-memory value; it must never reach the checkpoint file.
 *
 * When `passphrase` is supplied, also encrypts `pem`, `clientSecret`, and
 * `webhookSecret` on the coordinator and every persona via {@link encryptValue}.
 * When `passphrase` is omitted the fields are written as-is (backwards-
 * compatible for callers that haven't yet wired a passphrase — e.g.
 * `driver/apps.ts` until its companion subtask is done).
 *
 * This is the single source of sanitization policy: every call site that
 * persists wizard state must pass state through this function before calling
 * {@link saveState}.
 *
 * @param state      Wizard state to sanitize (not mutated).
 * @param passphrase When provided, sensitive credential fields are encrypted.
 */
export function stateForSave(state: WizardState, passphrase?: string): WizardState {
  const stripped: WizardState = { ...state, anthropic: undefined };
  if (!passphrase) return stripped;

  return {
    ...stripped,
    coordinator: stripped.coordinator
      ? encryptPersonaCreds(stripped.coordinator, passphrase)
      : undefined,
    personas: Object.fromEntries(
      Object.entries(stripped.personas).map(([k, v]) => [
        k,
        v ? encryptPersonaCreds(v, passphrase) : v,
      ]),
    ),
  };
}

/**
 * Decrypt encrypted credential fields in a state object loaded from disk.
 *
 * Walks `state.coordinator` and every entry in `state.personas`, calling
 * {@link decryptValue} on any field that matches {@link EncryptedValueSchema}
 * and leaving plaintext strings untouched (defensive: supports v1 migration
 * path where a file may have a mix of plaintext and encrypted fields).
 *
 * @param state      Parsed wizard state (may contain {@link EncryptedValue} fields).
 * @param passphrase Passphrase used during encryption.
 * @throws {@link DecryptError} if any field fails AES-GCM authentication.
 */
export function decryptStateOnLoad(state: WizardState, passphrase: string): WizardState {
  return {
    ...state,
    coordinator: state.coordinator
      ? decryptPersonaCreds(state.coordinator, passphrase)
      : undefined,
    personas: Object.fromEntries(
      Object.entries(state.personas).map(([k, v]) => [
        k,
        v ? decryptPersonaCreds(v, passphrase) : v,
      ]),
    ),
  };
}

/** Options accepted by {@link loadState}, {@link saveState}, and {@link clearState}. */
export interface StateOptions {
  /**
   * Directory that holds state files.
   * Defaults to `~/.config/agentify`.
   */
  dir?: string;
  /**
   * When supplied, {@link loadState} decrypts `EncryptedValue`-shaped
   * credential fields (pem, clientSecret, webhookSecret) after parsing.
   *
   * If the parsed state contains any encrypted field and `passphrase` is
   * **not** supplied, {@link loadState} throws an error rather than returning
   * opaque ciphertext objects to the caller.
   */
  passphrase?: string;
}

/**
 * Read and parse the state file for `prefix`.
 *
 * Returns `null` when the file does not exist.
 * Throws a descriptive error (including the file path) when the file exists
 * but cannot be parsed — **never** silently overwrites a malformed file.
 *
 * @param prefix  The App-name prefix chosen by the operator.
 * @param opts    Optional directory override.
 */
export async function loadState(
  prefix: string,
  opts?: StateOptions,
): Promise<WizardState | null> {
  const dir = opts?.dir ?? defaultDir();
  const filePath = statePath(prefix, dir);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `State file at "${filePath}" contains invalid JSON and cannot be parsed. ` +
        'Fix or remove the file before running agentify-setup again.',
    );
  }

  const result = WizardStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `State file at "${filePath}" does not match the expected schema: ` +
        result.error.message,
    );
  }

  const passphrase = opts?.passphrase;
  if (passphrase) {
    return decryptStateOnLoad(result.data, passphrase);
  }

  // Guard: if any credential field is an EncryptedValue but no passphrase was
  // supplied, fail loudly rather than returning ciphertext objects to the caller.
  if (hasEncryptedFields(result.data)) {
    throw new Error(
      `State file at "${filePath}" contains encrypted fields — a passphrase is required. ` +
        'Re-run agentify-setup with the passphrase used when the state was saved.',
    );
  }

  return result.data;
}

/**
 * Atomically write `state` to disk.
 *
 * The serialised JSON is written to a sibling `.tmp` file first, then
 * renamed into place via {@link renameSync} so a crash during the write
 * leaves the previous file intact.  The final file mode is set to `0o600`
 * (owner read/write only) before the rename.
 *
 * The parent directory is created with mode `0o700` if it does not exist.
 *
 * @param state  Wizard state to persist.
 * @param opts   Optional directory override.
 */
export async function saveState(
  state: WizardState,
  opts?: StateOptions,
): Promise<void> {
  const dir = opts?.dir ?? defaultDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const filePath = statePath(state.prefix, dir);
  const tmp = tmpPath(filePath);

  const json = JSON.stringify(state, null, 2);
  await fs.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 });

  // Ensure mode is 0o600 regardless of the process umask.
  await fs.chmod(tmp, 0o600);

  // Atomic rename: on POSIX this is a single rename(2) syscall.
  renameSync(tmp, filePath);
}

/**
 * Remove the state file for `prefix`.  No-op when the file does not exist.
 *
 * @param prefix  The App-name prefix chosen by the operator.
 * @param opts    Optional directory override.
 */
export async function clearState(
  prefix: string,
  opts?: StateOptions,
): Promise<void> {
  const dir = opts?.dir ?? defaultDir();
  const filePath = statePath(prefix, dir);

  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Return `true` when `value` is an {@link EncryptedValue} object. */
function isEncryptedValue(value: unknown): value is EncryptedValue {
  return EncryptedValueSchema.safeParse(value).success;
}

/**
 * Encrypt sensitive fields in a single set of persona credentials.
 * Already-encrypted fields are left untouched (idempotent / defensive).
 */
function encryptPersonaCreds(creds: PersonaCreds, passphrase: string): PersonaCreds {
  return {
    ...creds,
    pem: typeof creds.pem === 'string'
      ? encryptValue(creds.pem, passphrase)
      : creds.pem,
    clientSecret: typeof creds.clientSecret === 'string'
      ? encryptValue(creds.clientSecret, passphrase)
      : creds.clientSecret,
    webhookSecret:
      creds.webhookSecret !== null && typeof creds.webhookSecret === 'string'
        ? encryptValue(creds.webhookSecret, passphrase)
        : creds.webhookSecret,
  };
}

/**
 * Decrypt sensitive fields in a single set of persona credentials.
 * Plaintext strings are left untouched (defensive: supports v1 migration path).
 */
function decryptPersonaCreds(creds: PersonaCreds, passphrase: string): PersonaCreds {
  return {
    ...creds,
    pem: isEncryptedValue(creds.pem)
      ? decryptValue(creds.pem, passphrase)
      : creds.pem,
    clientSecret: isEncryptedValue(creds.clientSecret)
      ? decryptValue(creds.clientSecret, passphrase)
      : creds.clientSecret,
    webhookSecret:
      creds.webhookSecret !== null && isEncryptedValue(creds.webhookSecret)
        ? decryptValue(creds.webhookSecret, passphrase)
        : creds.webhookSecret,
  };
}

/**
 * Return `true` if any credential field in `state` is an {@link EncryptedValue}.
 * Used by {@link loadState} to detect encrypted state files that require a passphrase.
 */
function hasEncryptedFields(state: WizardState): boolean {
  const checkCreds = (creds: PersonaCreds): boolean =>
    isEncryptedValue(creds.pem) ||
    isEncryptedValue(creds.clientSecret) ||
    (creds.webhookSecret !== null && isEncryptedValue(creds.webhookSecret));

  if (state.coordinator && checkCreds(state.coordinator)) return true;

  for (const creds of Object.values(state.personas)) {
    if (creds && checkCreds(creds)) return true;
  }

  return false;
}
