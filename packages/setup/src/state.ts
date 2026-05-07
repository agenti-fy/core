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
import { EncryptedValueSchema } from './crypto.js';

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
 * are migrated on load — see the v1→v2 migration subtask for that logic.
 */
export const WizardStateSchema = z.object({
  /**
   * Schema version — always 2 for files written by this module.
   * V1 files are migrated on load (forward-reference: see migration subtask).
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
 * Strip long-lived secrets before writing state to disk (v1 policy: #426/#430).
 *
 * `anthropic.value` is held in memory so the finalize phase can render it to
 * `.env`, but it must never be written to the checkpoint file.  On `resume`,
 * if `state.anthropic` is absent the wizard re-prompts — that is the correct
 * behaviour per the spec.
 *
 * This is the single source of sanitization policy: every call site that
 * persists wizard state (orchestrator top-level saves in `index.ts` AND
 * per-persona checkpoints in `driver/apps.ts`) must pass state through this
 * function before handing it to `saveState`.
 */
export function stateForSave(state: WizardState): WizardState {
  return { ...state, anthropic: undefined };
}

/** Options accepted by {@link loadState}, {@link saveState}, and {@link clearState}. */
export interface StateOptions {
  /**
   * Directory that holds state files.
   * Defaults to `~/.config/agentify`.
   */
  dir?: string;
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
