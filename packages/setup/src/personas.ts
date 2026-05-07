/**
 * personas.ts — canonical 9-persona catalog for the setup wizard.
 *
 * This is the single source of truth for:
 *  - persona ordering (mirrors BUILTIN_PERSONAS from @agentify/shared)
 *  - environment-variable prefixes used by docker-compose.yml
 *  - GitHub App name suffix (the <persona> segment appended to the user prefix)
 *  - required GitHub App permissions
 *  - the App webhook-event list (empty — we poll, not webhook)
 *
 * All downstream modules (manifest.ts, env-renderer.ts, driver/apps.ts, …)
 * import from here; do NOT duplicate the list elsewhere.
 */

import { BUILTIN_PERSONAS, PERSONA_DEFAULTS } from '@agentify/shared';

/**
 * A single entry in the wizard persona catalog.
 *
 * - `name`         — lowercase persona identifier matching BUILTIN_PERSONAS
 * - `envPrefix`    — uppercase env-var prefix, e.g. "ORCHESTRATOR"
 * - `appNameSuffix`— the <persona> segment appended after the operator prefix,
 *                    e.g. "<prefix>-orchestrator"
 * - `signature`    — the canonical commit/comment signature for this persona,
 *                    re-exported from PERSONA_DEFAULTS
 */
export interface WizardPersona {
  readonly name: (typeof BUILTIN_PERSONAS)[number];
  readonly envPrefix: string;
  readonly appNameSuffix: string;
  readonly signature: string;
}

/**
 * Ordered catalog of the nine built-in personas.
 *
 * The order matches BUILTIN_PERSONAS exactly so that any iteration
 * (e.g. the per-persona App-creation loop) produces a deterministic,
 * human-readable sequence.
 */
export const WIZARD_PERSONAS: readonly WizardPersona[] = Object.freeze(
  BUILTIN_PERSONAS.map((name) =>
    Object.freeze({
      name,
      envPrefix: name.toUpperCase(),
      appNameSuffix: name,
      signature: PERSONA_DEFAULTS[name].signature,
    }),
  ),
);

/**
 * Required GitHub App permissions for each persona App.
 *
 * Source: README.md §"GitHub App setup" (lines 182-187).
 * The manifest builder imports this directly so the README and manifest
 * are always in sync.
 */
export const APP_PERMISSIONS = Object.freeze({
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  metadata: 'read',
} as const);

/**
 * GitHub App webhook events subscribed to by each persona App.
 *
 * We poll rather than receive webhooks, so this list is intentionally empty.
 * The App Manifest flow requires the field to be present; an empty array is valid.
 */
export const APP_DEFAULT_EVENTS: readonly string[] = Object.freeze([]);
