import { describe, it, expect } from 'vitest';
import { Octokit } from '@octokit/rest';
import {
  exchangeManifest,
  ManifestCodeExpiredError,
  type ExchangedApp,
} from './manifest-exchange.js';

// ---------------------------------------------------------------------------
// Golden fixture — mirrors the real GitHub API 201 response body for
// POST /app-manifests/{code}/conversions
// ---------------------------------------------------------------------------
const GOLDEN_RAW = {
  id: 12345,
  slug: 'my-test-app',
  node_id: 'MDM6QXBwMTIzNDU=',
  name: 'My Test App',
  description: 'Integration test fixture',
  external_url: 'https://example.com',
  html_url: 'https://github.com/apps/my-test-app',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  permissions: { issues: 'write', metadata: 'read' },
  events: ['issues', 'pull_request'],
  installations_count: 0,
  client_id: 'Iv1.abc12345678',
  client_secret: 's3cr3t_cl13nt_s3cr3t_v@lue',
  webhook_secret: 'wh00k_s3cr3t_v@lue',
  // Real newlines in the PEM — must be passed through unchanged.
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
  owner: {
    login: 'octocat',
    id: 1,
    node_id: 'MDQ6VXNlcjE=',
    avatar_url: 'https://github.com/images/error/octocat_happy.gif',
    gravatar_id: '',
    url: 'https://api.github.com/users/octocat',
    html_url: 'https://github.com/octocat',
    followers_url: 'https://api.github.com/users/octocat/followers',
    following_url: 'https://api.github.com/users/octocat/following{/other_user}',
    gists_url: 'https://api.github.com/users/octocat/gists{/gist_id}',
    starred_url: 'https://api.github.com/users/octocat/starred{/owner}{/repo}',
    subscriptions_url: 'https://api.github.com/users/octocat/subscriptions',
    organizations_url: 'https://api.github.com/users/octocat/orgs',
    repos_url: 'https://api.github.com/users/octocat/repos',
    events_url: 'https://api.github.com/users/octocat/events{/privacy}',
    received_events_url: 'https://api.github.com/users/octocat/received_events',
    type: 'User',
    site_admin: false,
    starred_at: undefined,
  },
};

/** The ExchangedApp value that GOLDEN_RAW should produce. */
const EXPECTED_APP: ExchangedApp = {
  id: 12345,
  slug: 'my-test-app',
  name: 'My Test App',
  htmlUrl: 'https://github.com/apps/my-test-app',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
  clientId: 'Iv1.abc12345678',
  clientSecret: 's3cr3t_cl13nt_s3cr3t_v@lue',
  webhookSecret: 'wh00k_s3cr3t_v@lue',
  ownerLogin: 'octocat',
};

// ---------------------------------------------------------------------------
// Stub helpers — wrap octokit's `request` hook so no real HTTP calls are made
// ---------------------------------------------------------------------------

/**
 * Creates an Octokit whose request hook always returns the given fixture
 * with a 201 status (simulating a successful manifest exchange).
 */
function makeSuccessOctokit(fixture: unknown): Octokit {
  const octokit = new Octokit();
  octokit.hook.wrap('request', async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ status: 201, headers: {}, url: 'https://api.github.com/...', data: fixture }) as any,
  );
  return octokit;
}

/**
 * Creates an Octokit whose request hook throws an error with the given status
 * code (duck-typing the shape of @octokit/request-error's RequestError).
 */
function makeErrorOctokit(status: number, message = 'HTTP error'): Octokit {
  const octokit = new Octokit();
  octokit.hook.wrap('request', async () => {
    throw Object.assign(new Error(message), { status });
  });
  return octokit;
}

/**
 * Creates an Octokit whose request hook throws a plain Error with no `status`
 * property (simulates a network-level failure like ECONNREFUSED).
 */
function makeNetworkErrorOctokit(message: string): Octokit {
  const octokit = new Octokit();
  octokit.hook.wrap('request', async () => {
    throw new Error(message);
  });
  return octokit;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exchangeManifest — happy path', () => {
  it('maps snake_case API response to camelCase ExchangedApp', async () => {
    const result = await exchangeManifest('code123', makeSuccessOctokit(GOLDEN_RAW));
    expect(result).toEqual(EXPECTED_APP);
  });

  it('preserves real newlines in the PEM field unchanged', async () => {
    const result = await exchangeManifest('code123', makeSuccessOctokit(GOLDEN_RAW));
    expect(result.pem).toBe(GOLDEN_RAW.pem);
    expect(result.pem).toContain('\n');
    expect(result.pem).not.toContain('\\n');
  });

  it('maps null webhook_secret to null (not undefined)', async () => {
    const fixture = { ...GOLDEN_RAW, webhook_secret: null };
    const result = await exchangeManifest('code123', makeSuccessOctokit(fixture));
    expect(result.webhookSecret).toBeNull();
  });

  it('falls back to empty string when slug is absent from the response', async () => {
    const { slug: _omitted, ...fixtureNoSlug } = GOLDEN_RAW;
    const result = await exchangeManifest('code123', makeSuccessOctokit(fixtureNoSlug));
    expect(result.slug).toBe('');
  });

  it('extracts ownerLogin from the owner.login field', async () => {
    const result = await exchangeManifest('code123', makeSuccessOctokit(GOLDEN_RAW));
    expect(result.ownerLogin).toBe('octocat');
  });

  it('returns all required ExchangedApp fields', async () => {
    const result = await exchangeManifest('code123', makeSuccessOctokit(GOLDEN_RAW));
    const keys: Array<keyof ExchangedApp> = [
      'id',
      'slug',
      'name',
      'htmlUrl',
      'pem',
      'clientId',
      'clientSecret',
      'webhookSecret',
      'ownerLogin',
    ];
    for (const key of keys) {
      expect(result, `missing field "${key}"`).toHaveProperty(key);
    }
  });
});

describe('exchangeManifest — 404 → ManifestCodeExpiredError', () => {
  it('throws ManifestCodeExpiredError when the API returns 404', async () => {
    await expect(
      exchangeManifest('expired-code', makeErrorOctokit(404, 'Not Found')),
    ).rejects.toBeInstanceOf(ManifestCodeExpiredError);
  });

  it('includes the expired code in the ManifestCodeExpiredError message', async () => {
    const err = await exchangeManifest('my-expired-code-123', makeErrorOctokit(404)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ManifestCodeExpiredError);
    expect((err as ManifestCodeExpiredError).message).toContain('my-expired-code-123');
  });

  it('mentions expiry in the error message (operator-friendly)', async () => {
    const err = await exchangeManifest('test', makeErrorOctokit(404)).catch((e: unknown) => e);
    expect((err as ManifestCodeExpiredError).message).toMatch(/expir/i);
  });
});

describe('exchangeManifest — non-404 errors bubble unchanged', () => {
  it('re-throws 5xx errors without wrapping', async () => {
    const originalErr = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const octokit = new Octokit();
    octokit.hook.wrap('request', async () => {
      throw originalErr;
    });

    const thrown = await exchangeManifest('code123', octokit).catch((e: unknown) => e);
    expect(thrown).toBe(originalErr);
  });

  it('re-throws 422 validation errors without wrapping', async () => {
    const thrown = await exchangeManifest('bad', makeErrorOctokit(422, 'Validation Failed')).catch(
      (e: unknown) => e,
    );
    expect(thrown).not.toBeInstanceOf(ManifestCodeExpiredError);
    expect((thrown as Error).message).toBe('Validation Failed');
  });

  it('re-throws network errors (no status) without wrapping', async () => {
    const networkErr = new Error('connect ECONNREFUSED 127.0.0.1:443');
    const octokit = makeNetworkErrorOctokit(networkErr.message);

    const thrown = await exchangeManifest('code123', octokit).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ManifestCodeExpiredError);
    expect((thrown as Error).message).toBe(networkErr.message);
  });
});

describe('ManifestCodeExpiredError', () => {
  it('is an instance of Error', () => {
    const err = new ManifestCodeExpiredError('test-code');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name "ManifestCodeExpiredError"', () => {
    const err = new ManifestCodeExpiredError('test-code');
    expect(err.name).toBe('ManifestCodeExpiredError');
  });

  it('exposes the original code on .code', () => {
    const err = new ManifestCodeExpiredError('abc-123');
    expect(err.code).toBe('abc-123');
  });

  it('contains the code in the message', () => {
    const err = new ManifestCodeExpiredError('abc-123');
    expect(err.message).toContain('abc-123');
  });

  it('message tells the operator to restart the wizard', () => {
    const err = new ManifestCodeExpiredError('x');
    expect(err.message).toMatch(/restart/i);
  });
});
