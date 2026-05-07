/**
 * KB page filename and persona-identity helpers.
 *
 * Single source of truth referenced by:
 *   - WikiManager.ensurePages (§252) — bootstrap page creation
 *   - agentify-kb CLI (§255) — the only supported write path
 *
 * Keeping derivation in one place means a change to the naming convention
 * (e.g. switching from Title-case to lower-case page names) is a one-line
 * edit rather than a cross-package search.
 */

import { PERSONA_DEFAULTS, isBuiltinPersona } from '@agentify/shared';

/**
 * Derive the wiki page filename (stem + `.md`) for a KB scope.
 *
 * Examples with defaults (KB_GLOBAL_PAGE='KB-Global', KB_PAGE_PREFIX='KB-'):
 *   kbPageFilename('global', 'tinkerer', 'KB-Global', 'KB-')  → 'KB-Global.md'
 *   kbPageFilename('persona', 'tinkerer', 'KB-Global', 'KB-') → 'KB-Tinkerer.md'
 *   kbPageFilename('persona', 'my-bot',  'KB-Global', 'KB-') → 'KB-My-bot.md'
 *
 * @param scope       'global' or 'persona'
 * @param persona     Lowercase persona name, e.g. 'tinkerer'
 * @param globalPage  Value of KB_GLOBAL_PAGE env var (without `.md`), e.g. 'KB-Global'
 * @param pagePrefix  Value of KB_PAGE_PREFIX env var, e.g. 'KB-'
 */
export function kbPageFilename(
  scope: 'global' | 'persona',
  persona: string,
  globalPage: string,
  pagePrefix: string,
): string {
  if (scope === 'global') {
    return `${globalPage}.md`;
  }
  // Pascal-case: capitalize first character only (persona names are lowercase).
  const pascal = persona.charAt(0).toUpperCase() + persona.slice(1);
  return `${pagePrefix}${pascal}.md`;
}

/**
 * Derive the persona signature footer used in KB entries.
 * Built-in personas: uses `PERSONA_DEFAULTS[persona].signature`.
 * Custom personas: falls back to the raw persona name string.
 *
 * Example output for 'tinkerer': '🔧 **The Tinkerer** · Implementation Specialist'
 */
export function kbPersonaSignature(persona: string): string {
  if (isBuiltinPersona(persona)) {
    return PERSONA_DEFAULTS[persona].signature;
  }
  return persona;
}

/**
 * Derive git user.name / user.email for KB commits.
 * Built-in personas: uses `PERSONA_DEFAULTS[persona].gitName` / `.gitEmail`.
 * Custom personas: falls back to persona name with a fixed local domain.
 */
export function kbGitIdentity(persona: string): { name: string; email: string } {
  if (isBuiltinPersona(persona)) {
    const d = PERSONA_DEFAULTS[persona];
    return { name: d.gitName, email: d.gitEmail };
  }
  return { name: persona, email: `${persona}@agentify.local` };
}
