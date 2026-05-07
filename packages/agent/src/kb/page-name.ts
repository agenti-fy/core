/**
 * KB page-name validation — the agent-trust boundary.
 *
 * agentify-kb is the only supported KB write path. The page-name regex is the
 * agent-trust boundary; agent JSON could otherwise embed `../`, NUL bytes, or
 * absurd lengths and rely on a downstream `path.join` / `git`-arg / shell
 * interpolation to misbehave.
 *
 * Skeptic's review note from PR #261:
 *   "Suggest enforcing `^KB-[A-Za-z0-9_-]+$` (or similar) at the agentify-kb
 *   CLI boundary, not at the schema layer, because the CLI runs the actual
 *   fs/git operations and is the correct trust boundary. Schema-level page
 *   tightening is defense-in-depth that we do not add now."
 *
 * Single source of truth — imported by:
 *   - agentify-kb CLI     (packages/agent/src/kb/cli.ts)
 *   - WikiManager         (packages/agent/src/kb/wiki.ts) — if bootstrap needs it
 */

/**
 * Regex that every KB page name stem (without the `.md` suffix) must satisfy.
 *
 * Breakdown:
 *   ^KB-              Required literal prefix — ensures every page is clearly
 *                     namespaced and distinguishable from arbitrary filenames.
 *   [A-Za-z0-9_-]    Strict allowlist: alphanumeric, underscore, hyphen only.
 *                     Excludes `.` (no extension confusion or `..` traversal),
 *                     `/`, `\` (no path separators), NUL, whitespace, and all
 *                     shell metacharacters.
 *   {1,196}           At least 1, at most 196 chars after the KB- prefix.
 *                     Maximum stem: KB-(3) + 196 = 199 chars; with .md suffix
 *                     the full filename is at most 202 chars.
 *   $                 Full-string match — no suffix characters allowed.
 */
const KB_PAGE_NAME_RE = /^KB-[A-Za-z0-9_-]{1,196}$/;

/**
 * Assert that `name` is a safe KB page name stem (without `.md` suffix).
 *
 * Throws an `Error` with a descriptive message on any of:
 *   - NUL byte present (`\0`)  — classic shell/syscall injection vector
 *   - Contains `..`, `/`, or `\` — path traversal or separator characters
 *   - Does not match `/^KB-[A-Za-z0-9_-]{1,196}$/` — violates the allowlist
 *   - Stem exceeds 199 characters (belt-and-suspenders; the regex already
 *     enforces this implicitly: KB-(3) + body(196) = 199 chars max)
 *
 * The caller is responsible for catching the thrown error and exiting with
 * a non-zero code (e.g. `process.exit(2)` in the CLI error path).
 *
 * @param name  The resolved page name stem, e.g. `KB-Tinkerer` or `KB-Global`.
 *              Must NOT include the `.md` suffix.
 *
 * @throws Error with a message beginning `refusing invalid page name`
 */
export function validateKbPageName(name: string): void {
  // 1. Fast-fail on NUL byte. NUL cannot be printed in error messages and is a
  //    classic shell/path injection vector independent of the allowlist below.
  if (name.includes('\0')) {
    throw new Error(
      `refusing invalid page name — contains NUL byte`,
    );
  }

  // 2. Defensive path-traversal and separator check. The regex below already
  //    excludes `.` and `/`/`\` from the allowed charset, but asserting here
  //    produces a targeted diagnostic and guards against future regex relaxation.
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(
      `refusing invalid page name "${name}" — contains path traversal or separator characters (.. / \\)`,
    );
  }

  // 3. Primary trust-boundary guard. Only names satisfying this regex are safe
  //    to pass into path.join(), git argv, commit messages, and wiki slugs
  //    without per-call-site re-escaping.
  if (!KB_PAGE_NAME_RE.test(name)) {
    throw new Error(
      `refusing invalid page name "${name}" — must match /^KB-[A-Za-z0-9_-]{1,196}$/`,
    );
  }

  // 4. Belt-and-suspenders length guard. The regex limits stems to 199 chars
  //    (KB-(3) + body(196)); this assertion only fires if the regex is somehow
  //    removed or relaxed without updating the length constraint.
  if (name.length > 199) {
    throw new Error(
      `refusing invalid page name "${name}" — stem exceeds 199 characters (filename with .md would exceed 202)`,
    );
  }
}
