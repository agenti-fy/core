/** GitHub repo reference. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** Parse `<owner>/<repo>` into a RepoRef. Throws on malformed input. */
export function parseRepo(s: string): RepoRef {
  const slash = s.indexOf('/');
  if (slash <= 0 || slash !== s.lastIndexOf('/') || slash === s.length - 1) {
    throw new Error(`invalid repo "${s}" — must be "<owner>/<repo>"`);
  }
  return { owner: s.slice(0, slash), repo: s.slice(slash + 1) };
}

/** Format a RepoRef as `<owner>/<repo>`. */
export function formatRepo(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}
