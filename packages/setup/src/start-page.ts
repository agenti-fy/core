/**
 * start-page.ts — HTML generator for the App Manifest auto-POST form.
 *
 * The App Manifest flow requires the manifest JSON to be sent as a POST form
 * body, which cannot be done from a `window.location` redirect. The wizard's
 * local server renders this tiny HTML page that auto-submits the form via JS.
 *
 * If JS is disabled the page shows a human-readable summary of what will be
 * created and a manual submit button via `<noscript>`.
 *
 * HTML-escaping rules (§ issue #421 Notes):
 *   &  →  &amp;    <  →  &lt;    >  →  &gt;    "  →  &quot;    '  →  &#39;
 */

import type { BuiltinPersona } from '@agentify/shared';
import type { GithubAppManifest } from './manifest.js';

// ── Types ─────────────────────────────────────────────────────────────────

/** Arguments accepted by {@link renderStartPage}. */
export interface StartPageArgs {
  /** The manifest payload to POST. */
  manifest: GithubAppManifest;
  /**
   * The GitHub URL the form POSTs to, e.g.
   * `https://github.com/settings/apps/new?state=<state>` or the org variant.
   */
  manifestStartUrl: string;
  /** The persona this App is being created for. */
  persona: BuiltinPersona;
  /** The human-readable App name, e.g. `"acme-orchestrator"`. */
  appName: string;
}

// ── HTML escaping ─────────────────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in HTML text content or attribute values.
 *
 * Converts the five characters that have special meaning in HTML/XML:
 *   &  →  &amp;
 *   <  →  &lt;
 *   >  →  &gt;
 *   "  →  &quot;
 *   '  →  &#39;
 */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Renderer ──────────────────────────────────────────────────────────────

/**
 * Render a complete HTML document that auto-POSTs the App Manifest JSON to
 * GitHub's manifest creation endpoint.
 *
 * The page is served once by the wizard's local callback server and is never
 * cached (the server sets `Cache-Control: no-store`).
 *
 * Layout:
 *  1. Human-readable summary (persona, App name, permissions, callback URL).
 *  2. Hidden form containing the JSON-encoded manifest.
 *  3. `<script>` that submits the form automatically.
 *  4. `<noscript>` fallback with a manual submit button.
 */
export function renderStartPage(args: StartPageArgs): string {
  const { manifest, manifestStartUrl, persona, appName } = args;

  // JSON-encode the manifest then HTML-escape it for use in a form value.
  const manifestJson = JSON.stringify(manifest);
  const escapedManifestJson = escapeHtml(manifestJson);
  const escapedStartUrl = escapeHtml(manifestStartUrl);
  const escapedPersona = escapeHtml(persona);
  const escapedAppName = escapeHtml(appName);

  // Build the human-readable permissions list from the manifest payload.
  const permissionsHtml = Object.entries(manifest.default_permissions)
    .map(([scope, level]) => `<li><code>${escapeHtml(scope)}</code>: ${escapeHtml(String(level))}</li>`)
    .join('\n        ');

  // Callback URL is embedded in the manifest's redirect_url field.
  const escapedCallbackUrl = escapeHtml(manifest.redirect_url);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Creating GitHub App: ${escapedAppName}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #24292f; }
    h1 { font-size: 1.4rem; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
    dt { font-weight: 600; }
    ul { margin: 0.25rem 0 0 1rem; padding: 0; }
    li { margin: 0; }
    code { background: #f6f8fa; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.9em; }
    .submit-btn { margin-top: 1rem; padding: 0.5rem 1.2rem; font-size: 1rem; cursor: pointer; }
    .note { color: #57606a; font-size: 0.9rem; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <h1>Creating GitHub App: ${escapedAppName}</h1>
  <p>Submitting the App Manifest to GitHub. You will be redirected to confirm App creation.</p>

  <dl>
    <dt>Persona</dt><dd>${escapedPersona}</dd>
    <dt>App name</dt><dd>${escapedAppName}</dd>
    <dt>Permissions</dt>
    <dd>
      <ul>
        ${permissionsHtml}
      </ul>
    </dd>
    <dt>Callback URL</dt><dd><code>${escapedCallbackUrl}</code></dd>
  </dl>

  <form method="post" action="${escapedStartUrl}" id="manifest-form">
    <input type="hidden" name="manifest" value="${escapedManifestJson}">
    <noscript>
      <p class="note">JavaScript is disabled. Click the button below to proceed to GitHub.</p>
      <button type="submit" class="submit-btn">Create GitHub App on GitHub &rarr;</button>
    </noscript>
  </form>

  <script>document.getElementById('manifest-form').submit()</script>
</body>
</html>`;
}
