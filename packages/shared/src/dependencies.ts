/**
 * Parse explicit issue dependencies from a free-form body.
 *
 * Recognizes (case-insensitive), only when the keyword **leads its line** —
 * after optional whitespace, blockquote markers, list markers, and emphasis:
 *   - "Depends on: #11, #12"
 *   - "Depends on #11"
 *   - "Blocked by: #11"
 *   - "Requires #11"
 *   - "After #11" / "After: #11"
 *
 * Markdown formatting is normalized first so all of these still match:
 *   - **Depends on**: #11
 *   - *Blocked by* #11
 *   - - Depends on: #11
 *   - * Requires: #11
 *
 * Importantly, mid-sentence prose uses of these verbs do NOT match. Earlier
 * versions used a non-anchored regex that swallowed the rest of the line
 * after any keyword occurrence — so a body containing "the parent issue
 * requires that … #191's first subtask" was treated as `Depends on: #191`
 * and dep-gated forever on a parent tracking issue. Anchoring to start-of-
 * line + restricting the captured tail to a `#N[,#N]*` run fixes both.
 *
 * Returns deduped, in declaration order. The work-poller uses these to
 * gate dispatch — an issue with any open dependency is skipped until the
 * dep closes (e.g. via `Closes #N` on a merged PR).
 */
export function parseDependencies(body: string): number[] {
  if (!body) return [];

  // Strip markdown emphasis so the start-of-line anchor catches patterns
  // like `- **Depends on**: #11`. List markers and blockquote markers are
  // tolerated by the leading character class in the regex itself.
  const normalized = body.replace(/\*\*/g, '').replace(/\*/g, '');

  // ^                            start of line (m flag)
  // [\s>*-]*                     optional whitespace / blockquote `>` / list markers `* -`
  // (?:depends?\s+on|...)        the keyword family
  // \s*[:.]?\s*                  optional `:` or `.`
  // ((?:#\d+[\s,]*)+)            captured run of `#N` references separated by space/comma
  // The captured run stops at the first non-`#N`, non-separator token, so
  // ad-hoc usages like "After #13 is merged, …" still capture #13 (and only
  // #13) but stray `#N`s further down the line are ignored.
  const LINE_RE =
    /^[\s>*-]*(?:depends?\s+on|blocked\s+by|requires?|after)\s*[:.]?\s*((?:#\d+[\s,]*)+)/gim;

  const seen = new Set<number>();
  const out: number[] = [];
  for (const match of normalized.matchAll(LINE_RE)) {
    const refs = match[1] ?? '';
    for (const n of refs.matchAll(/#(\d+)/g)) {
      const num = Number(n[1]);
      if (!Number.isFinite(num) || num <= 0) continue;
      if (seen.has(num)) continue;
      seen.add(num);
      out.push(num);
    }
  }
  return out;
}
