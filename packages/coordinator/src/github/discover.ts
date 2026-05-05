import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { CoordinatorStore } from '../store.js';
import type { GitHubClient } from './client.js';

/**
 * Refresh the coordinator's `repos` table from the GitHub App installation's
 * accessible repositories. Repos seen for the first time are added as active;
 * repos that have disappeared are deactivated (we keep the row so we don't
 * lose poll history if access is restored).
 */
export async function discoverRepos(
  github: GitHubClient,
  store: CoordinatorStore,
  config: Config,
  logger: Logger,
): Promise<void> {
  let seen: Set<string>;
  try {
    seen = await listInstallationRepos(github);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'repo discovery failed (will retry)',
    );
    return;
  }

  const existingRepos = store.listRepos();
  const before = new Map(existingRepos.map((r) => [r.repo, r]));

  for (const repo of seen) {
    const existing = before.get(repo);
    if (!existing) {
      logger.info({ repo }, 'discovered new repo');
      store.upsertRepo(repo, config.defaultPollIntervalSeconds, true);
    } else if (!existing.active) {
      // Known repo previously marked inactive — reactivate without
      // clobbering the operator-supplied poll_interval_s.
      logger.info({ repo }, 'repo accessible again — reactivating');
      store.upsertRepo(repo, existing.poll_interval_s, true);
    }
    // else: known and active — leave alone, preserving any PATCH-supplied tunings.
  }

  for (const [repo, existing] of before) {
    if (!seen.has(repo) && existing.active) {
      logger.info({ repo }, 'repo no longer accessible — deactivating');
      store.upsertRepo(repo, existing.poll_interval_s, false);
    }
  }
}

async function listInstallationRepos(github: GitHubClient): Promise<Set<string>> {
  const repos = new Set<string>();
  for await (const page of github.paginate.iterator(
    github.apps.listReposAccessibleToInstallation,
    { per_page: 100 },
  )) {
    // Octokit's pagination plugin special-cases this endpoint to flatten
    // `{ total_count, repositories }` into `data`. Fall back to the wrapped
    // shape if a future Octokit version stops doing that — without this,
    // a silent shape change would crash on `r.owner.login`.
    const list: ReadonlyArray<{ owner: { login: string }; name: string }> = Array.isArray(
      page.data,
    )
      ? page.data
      : ((page.data as { repositories?: ReadonlyArray<{ owner: { login: string }; name: string }> })
          .repositories ?? []);
    for (const r of list) {
      repos.add(`${r.owner.login}/${r.name}`);
    }
  }
  return repos;
}
