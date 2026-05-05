/**
 * Parse explicit issue dependencies from a free-form body.
 *
 * Recognizes (case-insensitive):
 *   - "Depends on: #11, #12"
 *   - "Depends on #11"
 *   - "Blocked by: #11"
 *   - "Requires #11"
 *   - "After #11" / "After: #11"
 *
 * Markdown formatting is normalized first so all of these work:
 *   - **Depends on**: #11
 *   - *Blocked by* #11
 *   - - Depends on: #11
 *   - * Requires: #11
 *
 * Returns deduped, in declaration order. The work-poller uses these to
 * gate dispatch — an issue with any open dependency is skipped until the
 * dep closes (e.g. via `Closes #N` on a merged PR).
 *
 * Lifted with light edits from the previous implementation
 * (agenti-fi/packages/core/src/agents/runner.ts:parseDependencies).
 */
export function parseDependencies(body: string): number[] {
  if (!body) return [];

  // Strip markdown emphasis + leading list markers so the keyword regex can
  // match patterns like `- **Depends on**: #11`.
  const normalized = body
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^[\s-]*-\s*/gm, '');

  // Match a keyword followed by the rest of the line. We extract issue
  // numbers from each matched line in a second pass so a single line can
  // declare multiple deps (`Depends on: #11, #12`).
  const KEYWORD_RE = /(?:depends?\s+on|blocked\s+by|requires?|after)[\s:]+[^\n]*/gi;

  const seen = new Set<number>();
  const out: number[] = [];
  for (const match of normalized.matchAll(KEYWORD_RE)) {
    for (const n of match[0].matchAll(/#(\d+)/g)) {
      const num = Number(n[1]);
      if (!Number.isFinite(num) || num <= 0) continue;
      if (seen.has(num)) continue;
      seen.add(num);
      out.push(num);
    }
  }
  return out;
}
