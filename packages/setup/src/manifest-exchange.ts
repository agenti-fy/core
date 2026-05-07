import { Octokit } from '@octokit/rest';

/**
 * The credentials returned by GitHub after exchanging a manifest flow code.
 * All field names are camelCase; raw snake_case names are internal to this module.
 */
export interface ExchangedApp {
  /** GitHub App numeric ID */
  id: number;
  /** URL-safe slug (e.g. "my-app") */
  slug: string;
  /** Display name of the App */
  name: string;
  /** GitHub App's HTML URL (e.g. "https://github.com/apps/my-app") */
  htmlUrl: string;
  /** PEM-encoded RSA private key with real (not escaped) newlines */
  pem: string;
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret */
  clientSecret: string;
  /**
   * Webhook secret as returned by GitHub, or null if GitHub didn't supply one.
   * Captured for completeness; the env-renderer discards it.
   */
  webhookSecret: string | null;
  /** Login of the user or org that owns the App */
  ownerLogin: string;
}

/**
 * Thrown when GitHub returns HTTP 404 for POST /app-manifests/{code}/conversions.
 * This happens when the code has expired (codes are valid for one hour per GitHub docs)
 * or when the code has already been consumed.
 */
export class ManifestCodeExpiredError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(
      `The GitHub App manifest code "${code}" has expired or was already used. ` +
        'Manifest codes expire after one hour — please restart the wizard to generate a fresh code.',
    );
    this.name = 'ManifestCodeExpiredError';
    this.code = code;
  }
}

/**
 * Duck-typed guard: returns true when `err` looks like an Octokit RequestError
 * with HTTP status 404.  We check by shape rather than `instanceof RequestError`
 * so we do not need to take a direct dependency on @octokit/request-error.
 */
function isOctokitNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    'status' in err &&
    err.status === 404
  );
}

/**
 * Exchanges a GitHub App manifest code for the App's credentials.
 *
 * Uses `POST /app-manifests/{code}/conversions` with no authentication (the
 * endpoint is unauthenticated by design — the code itself is the credential).
 *
 * Throws {@link ManifestCodeExpiredError} when GitHub responds with 404.
 * All other errors (network, 5xx, 422) propagate unchanged so the caller can
 * apply its own retry / back-off strategy.
 *
 * @param code    The short-lived code from GitHub's manifest-flow callback (?code=…)
 * @param octokit Octokit instance. Defaults to `new Octokit()` (no auth).
 *                Inject a pre-configured instance in unit tests to stub the HTTP layer.
 */
export async function exchangeManifest(
  code: string,
  octokit: Octokit = new Octokit(),
): Promise<ExchangedApp> {
  let data: Awaited<ReturnType<typeof octokit.apps.createFromManifest>>['data'];
  try {
    ({ data } = await octokit.apps.createFromManifest({ code }));
  } catch (err) {
    if (isOctokitNotFound(err)) {
      throw new ManifestCodeExpiredError(code);
    }
    throw err;
  }

  // `owner` is typed as simple-user | enterprise in the octokit schema.
  // For the manifest flow the owner is always a user/org account, so `login`
  // is always present.  We fall back to '' defensively for the enterprise case.
  const ownerLogin = 'login' in data.owner ? data.owner.login : '';

  return {
    id: data.id,
    // `slug` is optional in the base integration schema but always present on
    // a freshly created App.  Defensive fallback keeps the type sound.
    slug: data.slug ?? '',
    name: data.name,
    htmlUrl: data.html_url,
    pem: data.pem,
    clientId: data.client_id,
    clientSecret: data.client_secret,
    // The intersection type makes webhook_secret a required `string | null`.
    webhookSecret: data.webhook_secret,
    ownerLogin,
  };
}
