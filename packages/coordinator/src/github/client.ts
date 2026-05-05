import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { normalizePrivateKey, readPackageVersion } from '@agentify/shared';
import type { Config } from '../config.js';

export type GitHubClient = Octokit;

// dist/github/client.js → ../.. → coordinator package root
const VERSION = readPackageVersion(import.meta.url, 2);

/** Per-request hard cap. GitHub flakes occasionally; without this, a single
 *  stuck call hangs the calling poll loop forever (the loop awaits the call's
 *  promise, which never settles, so it never re-arms its setTimeout). */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Build an Octokit instance authenticated as a specific GitHub App installation.
 * Caller MUST have already verified config.disableGithub === false; the schema's
 * superRefine guarantees the four githubApp* fields are present in that case.
 */
export function createGitHubClient(config: Config): GitHubClient {
  if (
    !config.githubAppId ||
    !config.githubAppPrivateKey ||
    !config.githubAppInstallationId
  ) {
    throw new Error('createGitHubClient called with DISABLE_GITHUB=true config');
  }
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.githubAppId,
      privateKey: normalizePrivateKey(config.githubAppPrivateKey),
      installationId: config.githubAppInstallationId,
    },
    userAgent: `agentify-coordinator/${VERSION}`,
    request: {
      // Wrap the platform fetch so every Octokit request inherits a hard
      // timeout. Caller-supplied AbortSignals (rare in our codebase) are
      // composed via AbortSignal.any so we don't override them.
      fetch: (url: string, opts: RequestInit = {}): Promise<Response> => {
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = opts.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal;
        return fetch(url, { ...opts, signal });
      },
    },
  });
}
