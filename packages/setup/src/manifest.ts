/**
 * manifest.ts — GitHub App manifest payload builder.
 *
 * Builds the JSON manifest POSTed to the GitHub App Manifest creation
 * endpoint (https://github.com/settings/apps/new or the org-scoped variant).
 *
 * This module is pure data — no I/O, no HTTP calls.
 *
 * References:
 *   https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

import type { BuiltinPersona } from '@agentify/shared';
import { APP_PERMISSIONS, APP_DEFAULT_EVENTS } from './personas.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GitHub's maximum GitHub App name length. */
const GITHUB_APP_NAME_MAX_LENGTH = 34;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the composed App name exceeds GitHub's 34-character limit.
 * Fail-fast before the wizard opens browser tabs only for GitHub to reject.
 */
export class ManifestNameTooLongError extends Error {
  /** The full App name that exceeded the limit. */
  readonly appName: string;

  constructor(appName: string) {
    super(
      `GitHub App name "${appName}" is ${appName.length} characters, which exceeds the maximum of ${GITHUB_APP_NAME_MAX_LENGTH}.`,
    );
    this.name = 'ManifestNameTooLongError';
    this.appName = appName;
  }
}

/**
 * Thrown when a GitHub organisation login does not conform to GitHub's
 * documented login format.
 *
 * GitHub login rules (Personal accounts / Org names):
 *   - 1–39 characters
 *   - ASCII alphanumerics or hyphens only
 *   - No leading or trailing hyphen
 *   - No consecutive hyphens
 *
 * Reference: https://docs.github.com/en/organizations/managing-organization-settings/renaming-an-organization
 */
export class InvalidGithubLoginError extends Error {
  /** The offending login string that failed validation. */
  readonly login: string;

  constructor(login: string) {
    super(
      `"${login}" is not a valid GitHub login. Logins must be 1–39 characters, contain only ASCII alphanumerics or hyphens, and must not start or end with a hyphen or contain consecutive hyphens.`,
    );
    this.name = 'InvalidGithubLoginError';
    this.login = login;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that `login` conforms to GitHub's documented login format.
 *
 * GitHub login rules (Personal accounts / Org names):
 *   - 1–39 characters
 *   - ASCII alphanumerics or hyphens only (`[A-Za-z0-9-]`)
 *   - No leading or trailing hyphen
 *   - No consecutive hyphens
 *
 * Reference: https://docs.github.com/en/organizations/managing-organization-settings/renaming-an-organization
 *
 * Equivalent regex: `^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$`
 *
 * @throws {@link InvalidGithubLoginError} when `login` does not match the format.
 */
export function validateGithubLogin(login: string): void {
  // GitHub login: 1–39 chars, alphanumerics + hyphens, no leading/trailing
  // hyphen, no consecutive hyphens.
  // The lookahead `-(?=[A-Za-z0-9])` ensures each hyphen is followed by an
  // alphanumeric character, preventing trailing and consecutive hyphens.
  const GITHUB_LOGIN_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
  if (!GITHUB_LOGIN_REGEX.test(login)) {
    throw new InvalidGithubLoginError(login);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Arguments for building a GitHub App manifest.
 */
export interface BuildManifestArgs {
  /** Operator-supplied prefix, e.g. "agentify-alice". */
  prefix: string;
  /** The persona this App represents, e.g. "orchestrator". */
  persona: BuiltinPersona;
  /**
   * The URL GitHub will redirect to after the user clicks "Create GitHub App"
   * in the manifest flow (the `?code=&state=` callback).
   */
  callbackUrl: string;
}

/**
 * The official GitHub App manifest shape.
 *
 * Only fields we set are listed; optional fields we intentionally omit
 * (hook_attributes, setup_url) are not present.
 */
export interface GithubAppManifest {
  /** App name — `<prefix>-<persona>`, 1-34 chars [A-Za-z0-9-_]. */
  name: string;
  /** Homepage URL (placeholder; GitHub requires the field). */
  url: string;
  /**
   * OAuth callback URL.
   * Named `redirect_url` in the manifest spec (not `callback_url`).
   */
  redirect_url: string;
  /**
   * Additional OAuth callback URLs.
   * We only need one, so this is always an empty array.
   */
  callback_urls: string[];
  /** Whether the App is publicly listable. Always false for wizard Apps. */
  public: boolean;
  /** When the App is updated, should GitHub redirect to setup_url? */
  setup_on_update: boolean;
  /**
   * Required repository/account permissions.
   * Imported from `personas.ts` — single source of truth.
   */
  default_permissions: typeof APP_PERMISSIONS;
  /**
   * Webhook events the App subscribes to.
   * Empty — we poll rather than receive webhooks.
   */
  default_events: readonly string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Build the GitHub App manifest JSON payload for `persona`.
 *
 * Throws {@link ManifestNameTooLongError} if `<prefix>-<persona>` exceeds
 * GitHub's 34-character limit so callers fail before opening browser tabs.
 */
export function buildManifest(args: BuildManifestArgs): GithubAppManifest {
  const { prefix, persona, callbackUrl } = args;
  const name = `${prefix}-${persona}`;

  if (name.length > GITHUB_APP_NAME_MAX_LENGTH) {
    throw new ManifestNameTooLongError(name);
  }

  return {
    name,
    // GitHub requires a homepage URL; we use a sensible placeholder that
    // operators can override after app creation.
    url: 'https://github.com/agenti-fy/core',
    redirect_url: callbackUrl,
    callback_urls: [],
    public: false,
    setup_on_update: false,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_DEFAULT_EVENTS,
  };
}

// ---------------------------------------------------------------------------
// Manifest-start URL
// ---------------------------------------------------------------------------

/**
 * Arguments for constructing the GitHub URL that opens the manifest form.
 */
export interface ManifestStartUrlArgs {
  /** Whether the target is a personal user account or an organisation. */
  ownerType: 'user' | 'org';
  /**
   * Organisation login — required when `ownerType === 'org'`;
   * ignored for personal accounts.
   */
  orgLogin?: string;
  /**
   * Per-persona nonce generated by the driver.
   * Surfaced as `?state=<state>` so the callback server can correlate
   * the response to the correct persona.
   */
  state: string;
}

/**
 * Returns the GitHub URL the wizard should POST the manifest form to.
 *
 * - Personal: `https://github.com/settings/apps/new?state=<state>`
 * - Org:      `https://github.com/organizations/<org>/settings/apps/new?state=<state>`
 */
export function manifestStartUrl(args: ManifestStartUrlArgs): string {
  const { ownerType, orgLogin, state } = args;
  const encodedState = encodeURIComponent(state);

  if (ownerType === 'org') {
    if (!orgLogin) {
      throw new Error('orgLogin is required when ownerType is "org"');
    }
    validateGithubLogin(orgLogin);
    return `https://github.com/organizations/${orgLogin}/settings/apps/new?state=${encodedState}`;
  }

  return `https://github.com/settings/apps/new?state=${encodedState}`;
}
