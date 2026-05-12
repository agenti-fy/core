import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Octokit } from '@octokit/rest';
import {
  installUrl,
  awaitInstallation,
  InstallationTimeoutError,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  type RepoRef,
} from './install.js';
import type { ExchangedApp } from './manifest-exchange.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SAMPLE_APP: ExchangedApp = {
  id: 12345,
  slug: 'my-test-app',
  name: 'My Test App',
  htmlUrl: 'https://github.com/apps/my-test-app',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
  clientId: 'Iv1.abc12345678',
  clientSecret: 's3cr3t',
  webhookSecret: 'wh00k',
  ownerLogin: 'octocat',
};

const REPO_WITHOUT_IDS: RepoRef = {
  owner: 'my-org',
  name: 'my-repo',
};

const REPO_WITH_IDS: RepoRef = {
  owner: 'my-org',
  name: 'my-repo',
  ownerId: 9876,
  repoId: 5432,
};

// ── installUrl ────────────────────────────────────────────────────────────────

describe('installUrl — fallback shape (no ownerId/repoId)', () => {
  it('returns <htmlUrl>/installations/new when IDs are absent', () => {
    const url = installUrl(SAMPLE_APP, REPO_WITHOUT_IDS);
    expect(url).toBe('https://github.com/apps/my-test-app/installations/new');
  });

  it('uses the htmlUrl from the app, not the slug', () => {
    const appCustomUrl: ExchangedApp = {
      ...SAMPLE_APP,
      htmlUrl: 'https://github.com/apps/custom-slug-app',
      slug: 'custom-slug-app',
    };
    const url = installUrl(appCustomUrl, REPO_WITHOUT_IDS);
    expect(url).toBe('https://github.com/apps/custom-slug-app/installations/new');
  });

  it('falls back when only ownerId is provided (repoId absent)', () => {
    const repo: RepoRef = { ...REPO_WITHOUT_IDS, ownerId: 9876 };
    const url = installUrl(SAMPLE_APP, repo);
    expect(url).toBe('https://github.com/apps/my-test-app/installations/new');
  });

  it('falls back when only repoId is provided (ownerId absent)', () => {
    const repo: RepoRef = { ...REPO_WITHOUT_IDS, repoId: 5432 };
    const url = installUrl(SAMPLE_APP, repo);
    expect(url).toBe('https://github.com/apps/my-test-app/installations/new');
  });
});

describe('installUrl — pre-selection shape (ownerId + repoId)', () => {
  it('returns permissions URL with target_id and repository_ids[] when both IDs are present', () => {
    const url = installUrl(SAMPLE_APP, REPO_WITH_IDS);
    expect(url).toBe(
      'https://github.com/apps/my-test-app/installations/new/permissions?target_id=9876&repository_ids%5B%5D=5432',
    );
  });

  it('includes the app slug in the path', () => {
    const url = installUrl(SAMPLE_APP, REPO_WITH_IDS);
    expect(url).toContain('/apps/my-test-app/');
  });

  it('includes target_id query param', () => {
    const url = installUrl(SAMPLE_APP, REPO_WITH_IDS);
    expect(url).toContain('target_id=9876');
  });

  it('includes repository_ids[] query param', () => {
    const url = installUrl(SAMPLE_APP, REPO_WITH_IDS);
    expect(url).toContain('5432');
  });

  it('uses the numeric ownerId and repoId values', () => {
    const repo: RepoRef = { owner: 'acme', name: 'widget', ownerId: 111, repoId: 222 };
    const url = installUrl(SAMPLE_APP, repo);
    expect(url).toContain('target_id=111');
    expect(url).toContain('222');
  });
});

// ── awaitInstallation ─────────────────────────────────────────────────────────

type StubInstallation = { id: number; account: { login: string } | null };

/**
 * Build an Octokit stub whose `apps.listInstallations` call returns the given
 * sequence of responses.  When all responses are consumed, falls back to
 * returning the last response (so it never throws "No more stub responses").
 */
function makeOctokitStub(
  responses: Array<Array<StubInstallation>>,
): Octokit {
  let callCount = 0;
  const octokit = new Octokit();
  octokit.hook.wrap('request', async (request, options) => {
    if (
      typeof options.url === 'string' &&
      options.url.includes('/app/installations')
    ) {
      const idx = Math.min(callCount, responses.length - 1);
      callCount += 1;
      return {
        status: 200,
        headers: {},
        url: options.url,
        data: responses[idx] ?? [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }
    return request(options);
  });
  return octokit;
}

/**
 * Octokit stub that always returns an empty installation list.
 * Used for timeout tests so the stub never runs out of responses.
 */
function makeAlwaysEmptyOctokit(): Octokit {
  const octokit = new Octokit();
  octokit.hook.wrap('request', async (request, options) => {
    if (
      typeof options.url === 'string' &&
      options.url.includes('/app/installations')
    ) {
      return {
        status: 200,
        headers: {},
        url: options.url,
        data: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }
    return request(options);
  });
  return octokit;
}

describe('awaitInstallation — exports', () => {
  it('exports DEFAULT_INTERVAL_MS = 3000', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(3_000);
  });

  it('exports DEFAULT_TIMEOUT_MS = 600_000', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
  });
});

describe('awaitInstallation — polling', () => {
  it('resolves on the first poll when a matching installation already exists', async () => {
    const octokit = makeOctokitStub([
      [{ id: 77, account: { login: 'my-org' } }],
    ]);

    const result = await awaitInstallation(SAMPLE_APP, REPO_WITHOUT_IDS, {}, octokit);
    expect(result).toEqual({ installationId: 77 });
  });

  it('returns as soon as a matching installation appears after some polls', async () => {
    const octokit = makeOctokitStub([
      // First two polls: no matching installation
      [],
      [{ id: 1, account: { login: 'other-org' } }],
      // Third poll: matching installation present
      [
        { id: 1, account: { login: 'other-org' } },
        { id: 42, account: { login: 'my-org' } },
      ],
    ]);

    const result = await awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 0 },
      octokit,
    );
    expect(result).toEqual({ installationId: 42 });
  });

  it('filters on account.login === repo.owner (case-sensitive)', async () => {
    const octokit = makeOctokitStub([
      // Installations for other orgs — should not match
      [
        { id: 10, account: { login: 'MY-ORG' } },       // wrong case
        { id: 11, account: { login: 'other-org' } },     // different login
        { id: 12, account: { login: 'my-org-suffix' } }, // prefix match only
      ],
      // Match arrives
      [{ id: 99, account: { login: 'my-org' } }],
    ]);

    const result = await awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 0 },
      octokit,
    );
    expect(result).toEqual({ installationId: 99 });
  });

  it('ignores installations where account is null', async () => {
    const octokit = makeOctokitStub([
      [{ id: 50, account: null }],
      [{ id: 51, account: { login: 'my-org' } }],
    ]);

    const result = await awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 0 },
      octokit,
    );
    expect(result).toEqual({ installationId: 51 });
  });
});

describe('awaitInstallation — timeout', () => {
  it('throws InstallationTimeoutError when no installation appears before timeoutMs', async () => {
    // Use an always-empty stub so the stub never runs out of responses.
    // Use a long intervalMs so only one poll fires, then the timeout sleep
    // covers the remaining budget and the deadline fires on the next iteration.
    const octokit = makeAlwaysEmptyOctokit();

    const promise = awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 5_000, timeoutMs: 30 },
      octokit,
    );
    void promise.catch(() => {}); // suppress unhandled rejection
    await expect(promise).rejects.toBeInstanceOf(InstallationTimeoutError);
  });

  it('includes the install URL in the InstallationTimeoutError', async () => {
    const octokit = makeAlwaysEmptyOctokit();

    const err = await awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 5_000, timeoutMs: 30 },
      octokit,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InstallationTimeoutError);
    const te = err as InstallationTimeoutError;
    expect(te.installUrl).toBe('https://github.com/apps/my-test-app/installations/new');
    expect(te.message).toContain('https://github.com/apps/my-test-app/installations/new');
  });

  it('InstallationTimeoutError is an instance of Error', () => {
    const err = new InstallationTimeoutError('https://example.com');
    expect(err).toBeInstanceOf(Error);
  });

  it('InstallationTimeoutError has correct name', () => {
    const err = new InstallationTimeoutError('https://example.com');
    expect(err.name).toBe('InstallationTimeoutError');
  });
});

describe('awaitInstallation — transient-error retry', () => {
  /**
   * Build a stub that returns the given `status` (with an arbitrary message
   * body) for the first `failures` calls, then succeeds with
   * `eventualInstallations` from call `failures + 1` onward.
   *
   * Mimics GitHub propagation lag right after a manifest exchange — the App
   * is created but the read path (verifier, installations index) hasn't
   * caught up yet, so calls fail with various 401/404/5xx shapes before
   * stabilising.
   */
  function makeOctokitWithFailures(
    status: number,
    message: string,
    failures: number,
    eventualInstallations: Array<StubInstallation>,
  ): Octokit {
    let callCount = 0;
    const octokit = new Octokit();
    octokit.hook.wrap('request', async (request, options) => {
      if (
        typeof options.url === 'string' &&
        options.url.includes('/app/installations')
      ) {
        callCount += 1;
        if (callCount <= failures) {
          // Octokit's RequestError surfaces the body's message field on
          // err.message and exposes the HTTP status as err.status.
          const err = Object.assign(new Error(message), { status });
          throw err;
        }
        return {
          status: 200,
          headers: {},
          url: options.url,
          data: eventualInstallations,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      }
      return request(options);
    });
    return octokit;
  }

  it('retries on 401 "Integration must generate a public key" and resolves once the App settles', async () => {
    const octokit = makeOctokitWithFailures(
      401,
      'Integration must generate a public key',
      2,
      [{ id: 99, account: { login: 'my-org' } }],
    );

    const result = await awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 1, timeoutMs: 30_000 },
      octokit,
    );

    expect(result.installationId).toBe(99);
  });

  it('retries on other 401 shapes (JWT-decode, generic auth) — same propagation-lag bucket', async () => {
    // Right after manifest creation GitHub's auth plane briefly returns 401s
    // with assorted messages (JWT decode failures, generic "Bad credentials").
    // Operationally these clear within seconds, so the wizard treats every
    // 401 as transient and lets the deadline bound the wait.
    const octokit = makeOctokitWithFailures(
      401,
      'A JSON web token could not be decoded',
      2,
      [{ id: 99, account: { login: 'my-org' } }],
    );

    const result = await awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 1, timeoutMs: 30_000 },
      octokit,
    );

    expect(result.installationId).toBe(99);
  });

  it('retries on 404 responses (App not yet visible on read path)', async () => {
    const octokit = makeOctokitWithFailures(
      404,
      'Not Found',
      2,
      [{ id: 77, account: { login: 'my-org' } }],
    );

    const result = await awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 1, timeoutMs: 30_000 },
      octokit,
    );

    expect(result.installationId).toBe(77);
  });

  it('retries on 5xx responses (cached / edge errors right after creation)', async () => {
    const octokit = makeOctokitWithFailures(
      502,
      'Bad Gateway',
      2,
      [{ id: 55, account: { login: 'my-org' } }],
    );

    const result = await awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 1, timeoutMs: 30_000 },
      octokit,
    );

    expect(result.installationId).toBe(55);
  });

  it('still surfaces InstallationTimeoutError when the failure persists past the deadline', async () => {
    // Always-failing 401 → never recovers within timeoutMs.
    const octokit = makeOctokitWithFailures(
      401,
      'Integration must generate a public key',
      Number.POSITIVE_INFINITY,
      [],
    );
    const promise = awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 5, timeoutMs: 20 },
      octokit,
    );
    void promise.catch(() => {}); // suppress unhandled rejection
    await expect(promise).rejects.toBeInstanceOf(InstallationTimeoutError);
  });

  it('does not retry network-level failures with no HTTP status', async () => {
    // A plain Error without a numeric `status` is not a GitHub HTTP response
    // shape — it's something more fundamental (DNS, ECONNREFUSED, TLS).
    // Surface it immediately so the caller can react.
    const octokit = new Octokit();
    octokit.hook.wrap('request', async (_request, options) => {
      if (
        typeof options.url === 'string' &&
        options.url.includes('/app/installations')
      ) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:443');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    });

    const promise = awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 1, timeoutMs: 30_000 },
      octokit,
    );
    void promise.catch(() => {});
    await expect(promise).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('awaitInstallation — AbortSignal', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('rejects immediately when signal is already aborted before polling starts', async () => {
    const controller = new AbortController();
    controller.abort();

    const octokit = makeOctokitStub([[{ id: 1, account: { login: 'my-org' } }]]);

    const promise = awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { signal: controller.signal },
      octokit,
    );
    void promise.catch(() => {});
    await expect(promise).rejects.toBeInstanceOf(DOMException);
  });

  it('rejects with DOMException when signal fires during sleep', async () => {
    const controller = new AbortController();

    // Return no match on first poll, then abort during sleep
    let firstCallDone = false;
    const octokit = new Octokit();
    octokit.hook.wrap('request', async (_request, options) => {
      if (
        typeof options.url === 'string' &&
        options.url.includes('/app/installations')
      ) {
        if (!firstCallDone) {
          firstCallDone = true;
          // Abort after the first poll returns empty
          setImmediate(() => controller.abort());
          return {
            status: 200,
            headers: {},
            url: options.url,
            data: [],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any;
        }
        return {
          status: 200,
          headers: {},
          url: options.url,
          data: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      }
      return _request(options);
    });

    const promise = awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { intervalMs: 5_000, signal: controller.signal }, // long interval so abort fires first
      octokit,
    );
    void promise.catch(() => {});
    await expect(promise).rejects.toBeInstanceOf(DOMException);
  });

  it('does not throw when signal is provided but not aborted and installation resolves', async () => {
    const controller = new AbortController();
    const octokit = makeOctokitStub([[{ id: 7, account: { login: 'my-org' } }]]);

    const result = await awaitInstallation(
      SAMPLE_APP,
      REPO_WITHOUT_IDS,
      { signal: controller.signal },
      octokit,
    );
    expect(result).toEqual({ installationId: 7 });
  });
});
