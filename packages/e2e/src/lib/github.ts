import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { normalizeIssueLabels, parseRepo as sharedParseRepo, type RepoRef } from '@agentify/shared';
import type { Env } from './env.js';

export type { RepoRef };
// Re-export shared parseRepo. The previous local copy used `s.split('/')` +
// destructure, which silently truncates "owner/repo/extra" to {owner, repo}.
export const parseRepo = sharedParseRepo;

function normalizeKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

export function makeOctokit(env: Env): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey: normalizeKey(env.GITHUB_APP_PRIVATE_KEY),
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    },
    userAgent: 'agentify-e2e/0.1.0',
  });
}

export interface IssueRef {
  number: number;
  html_url: string;
  labels: string[];
  body: string;
}

export async function getIssue(
  octokit: Octokit,
  ref: RepoRef,
  number: number,
): Promise<IssueRef> {
  const { data } = await octokit.issues.get({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: number,
  });
  return toIssueRef(data);
}

export async function createIssue(
  octokit: Octokit,
  ref: RepoRef,
  args: { title: string; body: string; labels: string[] },
): Promise<IssueRef> {
  const { data } = await octokit.issues.create({
    owner: ref.owner,
    repo: ref.repo,
    title: args.title,
    body: args.body,
    labels: args.labels,
  });
  return toIssueRef(data);
}

export async function closeIssue(
  octokit: Octokit,
  ref: RepoRef,
  number: number,
  reason: 'completed' | 'not_planned' = 'not_planned',
): Promise<void> {
  await octokit.issues.update({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: number,
    state: 'closed',
    state_reason: reason,
  });
}

/** Find issues whose body references this parent number (`Parent: #N`). */
export async function findChildIssues(
  octokit: Octokit,
  ref: RepoRef,
  parentNumber: number,
): Promise<IssueRef[]> {
  // Bound to a digit boundary so #5 doesn't match #50.
  const parentRe = new RegExp(`Parent:\\s*#${parentNumber}(?!\\d)`);
  const out: IssueRef[] = [];
  for await (const page of octokit.paginate.iterator(octokit.issues.listForRepo, {
    owner: ref.owner,
    repo: ref.repo,
    state: 'all',
    per_page: 100,
  })) {
    for (const issue of page.data) {
      if ('pull_request' in issue && issue.pull_request != null) continue; // skip PRs
      const body = issue.body ?? '';
      if (parentRe.test(body)) out.push(toIssueRef(issue));
    }
  }
  return out;
}

interface RawIssue {
  number: number;
  html_url: string;
  body?: string | null;
  labels?: Array<string | { name?: string }>;
}

function toIssueRef(d: RawIssue): IssueRef {
  return {
    number: d.number,
    html_url: d.html_url,
    body: d.body ?? '',
    labels: normalizeIssueLabels(d.labels),
  };
}

export async function ensureRepoAccessible(
  octokit: Octokit,
  ref: RepoRef,
): Promise<{ default_branch: string; permissions: string[] }> {
  const { data } = await octokit.repos.get({ owner: ref.owner, repo: ref.repo });
  const perms: string[] = [];
  if (data.permissions?.admin) perms.push('admin');
  if (data.permissions?.push) perms.push('push');
  if (data.permissions?.pull) perms.push('pull');
  return { default_branch: data.default_branch, permissions: perms };
}
