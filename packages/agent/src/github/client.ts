import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { Logger } from 'pino';
import { normalizePrivateKey, parseRepo, readPackageVersion, type RepoRef } from '@agenti-fy/shared';
import type { Config } from '../config.js';

export { parseRepo, type RepoRef };

// dist/github/client.js → ../.. → agent package root
const VERSION = readPackageVersion(import.meta.url, 2);

function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    return typeof s === 'number' ? s : undefined;
  }
  return undefined;
}

/** Backed-by-Octokit GitHub helpers needed by the agent runner. */
export interface GitHubAdapter {
  /** True if real GitHub mutations will be performed. False = no-op + log. */
  readonly enabled: boolean;
  listLabels(repo: string, number: number): Promise<string[]>;
  addLabels(repo: string, number: number, labels: readonly string[]): Promise<void>;
  removeLabels(repo: string, number: number, labels: readonly string[]): Promise<void>;
  replaceLabels(repo: string, number: number, labels: readonly string[]): Promise<void>;
  /**
   * Append a marker to the issue body. Fetches the current body first so the
   * operator's original description is preserved — used as a fallback channel
   * when posting a comment fails. A previous version of this method REPLACED
   * the body, which destroyed user-authored content on every comment-fallback.
   */
  appendToIssueBody(repo: string, number: number, suffix: string): Promise<void>;
  postIssueComment(repo: string, number: number, body: string): Promise<void>;
  /**
   * Read PR merge state for runner-side verification — used after a `merge`
   * skill claims success to confirm the PR actually merged via `gh pr merge`
   * rather than being closed-without-merge or having its content pushed
   * directly to the default branch. Returns null when the adapter is in
   * no-github mode (verification is skipped, since there's no real PR to
   * check).
   */
  getPullRequest(
    repo: string,
    number: number,
  ): Promise<{ state: 'open' | 'closed'; merged: boolean; mergeCommitSha: string | null } | null>;
}

class OctokitGitHubAdapter implements GitHubAdapter {
  readonly enabled = true;

  constructor(
    private readonly octokit: Octokit,
    private readonly logger: Logger,
  ) {}

  async listLabels(repo: string, number: number): Promise<string[]> {
    const ref = parseRepo(repo);
    const { data } = await this.octokit.issues.listLabelsOnIssue({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: number,
      per_page: 100,
    });
    // Octokit's type allows label.name to be undefined though GitHub's API
    // never omits it for issue labels. Filter defensively.
    return data
      .map((l) => l.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  }

  async appendToIssueBody(repo: string, number: number, suffix: string): Promise<void> {
    const ref = parseRepo(repo);
    // Read-modify-write: GitHub's issues.update with `body` replaces the
    // entire body. Fetch the current contents first so we preserve the
    // operator's original description.
    const { data } = await this.octokit.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: number,
    });
    const existing = data.body ?? '';
    const next = existing.length > 0 ? `${existing}\n\n${suffix}` : suffix;
    await this.octokit.issues.update({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: number,
      body: next,
    });
    this.logger.debug(
      { repo, number, existing_chars: existing.length, suffix_chars: suffix.length },
      'github: appendToIssueBody',
    );
  }

  async addLabels(repo: string, number: number, labels: readonly string[]): Promise<void> {
    if (labels.length === 0) return;
    const ref = parseRepo(repo);
    await this.octokit.issues.addLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: number,
      labels: [...labels],
    });
    this.logger.debug({ repo, number, labels }, 'github: addLabels');
  }

  async removeLabels(repo: string, number: number, labels: readonly string[]): Promise<void> {
    if (labels.length === 0) return;
    const ref = parseRepo(repo);
    for (const label of labels) {
      try {
        await this.octokit.issues.removeLabel({
          owner: ref.owner,
          repo: ref.repo,
          issue_number: number,
          name: label,
        });
      } catch (err) {
        // 404 means the label wasn't on the issue — that's the desired end state.
        if (statusOf(err) !== 404) throw err;
      }
    }
    this.logger.debug({ repo, number, labels }, 'github: removeLabels');
  }

  async replaceLabels(repo: string, number: number, labels: readonly string[]): Promise<void> {
    const ref = parseRepo(repo);
    await this.octokit.issues.setLabels({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: number,
      labels: [...labels],
    });
    this.logger.debug({ repo, number, labels }, 'github: setLabels');
  }

  async postIssueComment(repo: string, number: number, body: string): Promise<void> {
    const ref = parseRepo(repo);
    await this.octokit.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: number,
      body,
    });
    this.logger.debug({ repo, number }, 'github: createComment');
  }

  async getPullRequest(
    repo: string,
    number: number,
  ): Promise<{ state: 'open' | 'closed'; merged: boolean; mergeCommitSha: string | null }> {
    const ref = parseRepo(repo);
    const { data } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
    });
    return {
      state: data.state,
      merged: data.merged,
      mergeCommitSha: data.merge_commit_sha ?? null,
    };
  }
}

class NullGitHubAdapter implements GitHubAdapter {
  readonly enabled = false;
  constructor(private readonly logger: Logger) {}

  async listLabels(repo: string, number: number): Promise<string[]> {
    this.logger.info({ repo, number }, '[no-github] listLabels');
    return [];
  }
  async appendToIssueBody(repo: string, number: number, suffix: string): Promise<void> {
    this.logger.info({ repo, number, suffix_chars: suffix.length }, '[no-github] appendToIssueBody');
  }
  async addLabels(repo: string, number: number, labels: readonly string[]): Promise<void> {
    this.logger.info({ repo, number, labels }, '[no-github] addLabels');
  }
  async removeLabels(repo: string, number: number, labels: readonly string[]): Promise<void> {
    this.logger.info({ repo, number, labels }, '[no-github] removeLabels');
  }
  async replaceLabels(repo: string, number: number, labels: readonly string[]): Promise<void> {
    this.logger.info({ repo, number, labels }, '[no-github] replaceLabels');
  }
  async postIssueComment(repo: string, number: number, body: string): Promise<void> {
    this.logger.info({ repo, number, body_chars: body.length }, '[no-github] postIssueComment');
  }
  async getPullRequest(
    repo: string,
    number: number,
  ): Promise<null> {
    this.logger.info({ repo, number }, '[no-github] getPullRequest');
    return null;
  }
}

export function createGitHubAdapter(config: Config, logger: Logger): GitHubAdapter {
  if (config.disableGithub) {
    logger.warn('DISABLE_GITHUB=true — real GitHub mutations suppressed');
    return new NullGitHubAdapter(logger);
  }
  // Schema's superRefine guarantees presence when disableGithub is false.
  if (
    !config.githubAppId ||
    !config.githubAppPrivateKey ||
    !config.githubAppInstallationId
  ) {
    throw new Error('createGitHubAdapter: missing GitHub App credentials despite DISABLE_GITHUB=false');
  }
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.githubAppId,
      privateKey: normalizePrivateKey(config.githubAppPrivateKey),
      installationId: config.githubAppInstallationId,
    },
    userAgent: `agentify-agent/${VERSION}`,
  });
  return new OctokitGitHubAdapter(octokit, logger);
}
