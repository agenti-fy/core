/**
 * passphrase.ts — session passphrase acquisition for the agentify-setup wizard.
 *
 * Provides a single source-of-truth for the operator-supplied passphrase that
 * drives `crypto.scrypt` key derivation.  The passphrase is returned as a
 * plain string; key derivation (scrypt + AES-GCM) lives in `crypto.ts`.
 *
 * Two resolution paths:
 *   1. Env-var override (`AGENTIFY_SETUP_PASSPHRASE`) — for CI/headless runs.
 *   2. Interactive — calls `askMasked` once (resume) or twice (init, confirm).
 *
 * Minimum passphrase length: {@link MIN_PASSPHRASE_LENGTH} characters.
 *
 * `PromptCancelled` from `askMasked` propagates unchanged so the
 * orchestrator's existing Ctrl-C handler keeps working.
 */

import { askMasked, type IoStreams } from './prompts.js';

// ── Constants ─────────────────────────────────────────────────────────────

/** Environment-variable name for the headless/CI passphrase override. */
export const PASSPHRASE_ENV_VAR = 'AGENTIFY_SETUP_PASSPHRASE';

/** Minimum accepted passphrase length (characters). */
export const MIN_PASSPHRASE_LENGTH = 12;

// ── Public API ────────────────────────────────────────────────────────────

export interface GetSessionPassphraseOpts {
  /**
   * The environment to check for {@link PASSPHRASE_ENV_VAR}.
   * Defaults to `process.env` when omitted.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * When `true` (used on `init`), prompt a second time and reject if the two
   * entries differ.  When `false` or omitted (used on `resume`), only one
   * prompt is issued.
   */
  confirm?: boolean;
}

/**
 * Return the passphrase for this wizard session.
 *
 * Resolution order:
 * 1. `opts.env.AGENTIFY_SETUP_PASSPHRASE` (or `process.env` if `opts.env` is
 *    omitted) — returned directly when non-empty, after length validation.
 * 2. Interactive `askMasked` prompt.  When `opts.confirm === true` a second
 *    prompt is issued and the two entries must match.
 *
 * @throws {Error} if the passphrase is shorter than {@link MIN_PASSPHRASE_LENGTH}.
 * @throws {Error} if `opts.confirm === true` and the two entries do not match.
 * @throws {PromptCancelled} if the user aborts an interactive prompt.
 */
export async function getSessionPassphrase(
  io: IoStreams,
  opts?: GetSessionPassphraseOpts,
): Promise<string> {
  const env = opts?.env ?? process.env;
  const envValue = env[PASSPHRASE_ENV_VAR];

  if (envValue !== undefined) {
    // Env-var path: validate and return (no prompt).
    assertMinLength(envValue);
    return envValue;
  }

  // Interactive path.
  const passphrase = await askMasked('Setup passphrase', io);
  assertMinLength(passphrase);

  if (opts?.confirm === true) {
    const confirmation = await askMasked('Confirm passphrase', io);
    if (passphrase !== confirmation) {
      throw new Error('Passphrases do not match. Please try again.');
    }
  }

  return passphrase;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function assertMinLength(value: string): void {
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `Passphrase is too short (${value.length} characters). ` +
        `A minimum of ${MIN_PASSPHRASE_LENGTH} characters is required.`,
    );
  }
}
