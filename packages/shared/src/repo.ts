/** GitHub repo reference. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** Allowed characters per segment: GitHub owner/repo intersection safe for shell. */
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/** Parse `<owner>/<repo>` into a RepoRef. Throws on malformed input. */
export function parseRepo(s: string): RepoRef {
  const slash = s.indexOf('/');
  if (slash <= 0 || slash !== s.lastIndexOf('/') || slash === s.length - 1) {
    throw new Error(`invalid repo "${s}" — must be "<owner>/<repo>"`);
  }
  const owner = s.slice(0, slash);
  const repo = s.slice(slash + 1);
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo)) {
    throw new Error(`invalid repo "${s}" — contains disallowed characters`);
  }
  return { owner, repo };
}

/** Format a RepoRef as `<owner>/<repo>`. */
export function formatRepo(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}
