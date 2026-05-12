/**
 * install.ts — installation URL helper and installation-id poller.
 *
 * After the App is created via the manifest flow, the user must install it on
 * the target repo.  GitHub provides no server-side redirect on installation, so
 * we open the install URL and poll `GET /app/installations` until the matching
 * installation appears (or a timeout / AbortSignal fires).
 */

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { ExchangedApp } from './manifest-exchange.js';

// ── Public constants ──────────────────────────────────────────────────────────

/** Default polling interval in milliseconds (3 seconds). */
export const DEFAULT_INTERVAL_MS = 3_000;

/** Default timeout in milliseconds (10 minutes). */
export const DEFAULT_TIMEOUT_MS = 600_000;

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown by {@link awaitInstallation} when the timeout expires before an
 * installation for the target repo owner appears.
 */
export class InstallationTimeoutError extends Error {
  /** The install URL that was opened for the user. */
  readonly installUrl: string;

  constructor(url: string) {
    super(
      `Timed out waiting for the GitHub App installation to appear. ` +
        `Please visit the install URL and install the App on the target repo:\n  ${url}`,
    );
    this.name = 'InstallationTimeoutError';
    this.installUrl = url;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Repo reference used for installation URL construction and polling.
 *
 * `ownerId` and `repoId` are optional numeric GitHub IDs.  When present, the
 * generated install URL will include `target_id` and `repository_ids[]` query
 * parameters that pre-select the repo on the GitHub install page, reducing the
 * number of clicks needed.  When absent, the simpler `<htmlUrl>/installations/new`
 * fallback is used; this always works but does not pre-select the repo.
 */
export interface RepoRef {
  /** GitHub user/org login (e.g. "my-org") */
  owner: string;
  /** Repository name without the owner prefix (e.g. "my-repo") */
  name: string;
  /** Numeric GitHub ID of the owner user/org (optional). */
  ownerId?: number;
  /** Numeric GitHub repository ID (optional). */
  repoId?: number;
}

// ── installUrl ────────────────────────────────────────────────────────────────

/**
 * Returns the GitHub URL the user must visit to install the App on their repo.
 *
 * - When `repo.ownerId` **and** `repo.repoId` are both present, returns the
 *   pre-selection URL:
 *   `https://github.com/apps/<slug>/installations/new/permissions?target_id=<ownerId>&repository_ids[]=<repoId>`
 *
 * - Otherwise falls back to:
 *   `<app.htmlUrl>/installations/new`
 */
export function installUrl(app: ExchangedApp, repo: RepoRef): string {
  if (repo.ownerId !== undefined && repo.repoId !== undefined) {
    const params = new URLSearchParams({
      target_id: String(repo.ownerId),
    });
    params.append('repository_ids[]', String(repo.repoId));
    return `https://github.com/apps/${app.slug}/installations/new/permissions?${params.toString()}`;
  }
  return `${app.htmlUrl}/installations/new`;
}

// ── awaitInstallation ─────────────────────────────────────────────────────────

/** Options accepted by {@link awaitInstallation}. */
export interface AwaitInstallationOptions {
  /** How many ms to wait between polls. Default: {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Maximum ms to wait before throwing {@link InstallationTimeoutError}. Default: {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Optional AbortSignal; when aborted the function rejects immediately. */
  signal?: AbortSignal;
}

/**
 * Polls `GET /app/installations` (App-JWT-authenticated) until an installation
 * for `repo.owner` appears, then resolves with `{ installationId }`.
 *
 * Throws {@link InstallationTimeoutError} when `timeoutMs` elapses.
 * Rejects with the AbortSignal reason (or a generic `DOMException`) when the
 * provided `signal` fires.
 *
 * @param app     Credentials returned by the manifest-exchange step.
 * @param repo    Target repo reference (only `owner` is used for matching).
 * @param opts    Optional polling tuning and AbortSignal.
 * @param _octokit  Injected for unit tests; defaults to a real App-JWT Octokit.
 */
export async function awaitInstallation(
  app: ExchangedApp,
  repo: RepoRef,
  opts?: AwaitInstallationOptions,
  _octokit?: Octokit,
): Promise<{ installationId: number }> {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts?.signal;

  const octokit =
    _octokit ??
    new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: app.id,
        privateKey: app.pem,
      },
    });

  const url = installUrl(app, repo);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // Check abort before polling.
    if (signal?.aborted) {
      throw asError(signal.reason, 'Aborted');
    }

    if (Date.now() >= deadline) {
      throw new InstallationTimeoutError(url);
    }

    let installations: Awaited<
      ReturnType<typeof octokit.apps.listInstallations>
    >['data'];
    try {
      ({ data: installations } = await octokit.apps.listInstallations());
    } catch (err) {
      if (isTransientGitHubError(err)) {
        // GitHub propagation lag between the manifest exchange and the App's
        // record being consistent on the read path. Observed shapes include
        // 401 "Integration must generate a public key" (verifier hasn't seen
        // the App's public key yet), other 401 variants right after creation,
        // and 404s from the App's API plane lagging the create. Cached/edge
        // 5xx responses fall in the same bucket. Treat any of these as
        // transient: sleep one interval and retry. The deadline still bounds
        // the wait, so a genuine misconfiguration (wrong PEM, revoked App,
        // clock skew) surfaces as InstallationTimeoutError instead of a
        // misleading immediate 401.
        await sleepWithSignal(intervalMs, signal);
        continue;
      }
      throw err;
    }

    const match = installations.find(
      (inst) =>
        inst.account != null &&
        'login' in inst.account &&
        inst.account.login === repo.owner,
    );

    if (match) {
      return { installationId: match.id };
    }

    // Wait up to intervalMs, but honour the deadline and the AbortSignal.
    const remaining = deadline - Date.now();
    const wait = Math.max(0, Math.min(intervalMs, remaining));

    await sleepWithSignal(wait, signal);
  }
}

// ── awaitRepoInstallation ────────────────────────────────────────────────────

/**
 * Polls `GET /repos/{owner}/{repo}/installation` (App-JWT-authenticated) until
 * the App can see the target repository, then returns the installation id.
 *
 * Distinct from {@link awaitInstallation}, which polls `/app/installations`
 * and matches by `account.login`. That helper returns IMMEDIATELY for an App
 * that's already installed somewhere with the same owner — useless for the
 * "install existing Apps on an additional repo" flow because the existing
 * installation is found before the operator has clicked through. This helper
 * asks GitHub the more specific question: "is the App's installation visible
 * from THIS repository?" — which only resolves to 200 once the operator has
 * added the repo to the installation's repository-access list.
 *
 * Throws {@link InstallationTimeoutError} when `timeoutMs` elapses without a
 * 200. 401 / 404 responses are treated as transient (the App is not yet
 * installed on this repo, or the JWT just minted hasn't propagated yet).
 * Other errors propagate unchanged.
 */
export async function awaitRepoInstallation(
  app: ExchangedApp,
  repo: RepoRef,
  opts?: AwaitInstallationOptions,
  _octokit?: Octokit,
): Promise<{ installationId: number }> {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts?.signal;

  const octokit =
    _octokit ??
    new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: app.id, privateKey: app.pem },
    });

  // For the wait-loop URL, prefer the repo's manage page on the App's
  // settings (operator can add the repo from there). The wizard's caller
  // owns opening the URL; this helper just polls.
  const probeUrl = `https://github.com/${repo.owner}/${repo.name}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted) {
      throw asError(signal.reason, 'Aborted');
    }
    if (Date.now() >= deadline) {
      throw new InstallationTimeoutError(probeUrl);
    }

    let installationId: number | null = null;
    try {
      const { data } = await octokit.apps.getRepoInstallation({
        owner: repo.owner,
        repo: repo.name,
      });
      installationId = data.id;
    } catch (err) {
      // 401 / 404 = "not yet visible from this repo"; 5xx = transient edge
      // / cache error right after manifest creation. The deadline still
      // bounds the wait, so a genuinely missing installation eventually
      // surfaces as InstallationTimeoutError.
      if (!isTransientGitHubError(err)) {
        throw err;
      }
    }

    if (installationId !== null) {
      return { installationId };
    }

    const remaining = deadline - Date.now();
    const wait = Math.max(0, Math.min(intervalMs, remaining));
    await sleepWithSignal(wait, signal);
  }
}

/**
 * Returns the numeric HTTP status when `err` looks like an Octokit
 * `RequestError` (which exposes `status` directly on the error), or
 * `undefined` for plain `Error`s and network-level failures.
 */
function httpStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  return 'status' in err && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : undefined;
}

/**
 * Detects GitHub responses that are transient in the immediate-post-create
 * window: 401 (verifier hasn't caught up to a freshly-issued PEM), 404 (App
 * not yet consistent on the read path), and 5xx (cached/edge errors).
 *
 * Genuine misconfigurations (wrong PEM, revoked App, clock-skew JWT
 * rejection) ALSO surface as 401 here. We accept that ambiguity because the
 * deadline still bounds the wait — a permanently broken App times out with
 * an InstallationTimeoutError, while a real propagation-lag 401 disappears
 * within a few seconds and the poll continues.
 */
function isTransientGitHubError(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === undefined) return false;
  return status === 401 || status === 404 || (status >= 500 && status < 600);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Resolves after `ms` milliseconds, or rejects early if `signal` fires.
 * A `wait` of 0 resolves on the next microtask tick.
 */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(asError(signal.reason, 'Aborted'));
      return;
    }

    if (ms === 0) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);
    // Allow the Node.js event loop to exit while we are sleeping.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(asError(signal.reason, 'Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Returns `reason` when it is already an `Error`; otherwise wraps it in one.
 * Used to satisfy `@typescript-eslint/prefer-promise-reject-errors` while still
 * propagating the original AbortSignal reason when it is a proper Error.
 */
function asError(reason: unknown, fallbackMessage: string): Error {
  return reason instanceof Error ? reason : new Error(fallbackMessage);
}
