import { describe, it, expect } from 'vitest';
import { BUILTIN_PERSONAS } from '@agentify/shared';
import { APP_PERMISSIONS } from './personas.js';
import {
  buildManifest,
  manifestStartUrl,
  ManifestNameTooLongError,
  OrgLoginRequiredError,
  validateGithubLogin,
  InvalidGithubLoginError,
} from './manifest.js';

// ---------------------------------------------------------------------------
// buildManifest — name
// ---------------------------------------------------------------------------

describe('buildManifest — name', () => {
  it('generates "<prefix>-<persona>" for every builtin persona', () => {
    for (const persona of BUILTIN_PERSONAS) {
      const manifest = buildManifest({
        prefix: 'agentify-alice',
        persona,
        callbackUrl: 'http://localhost:3000/callback',
      });
      expect(manifest.name).toBe(`agentify-alice-${persona}`);
    }
  });

  it('throws ManifestNameTooLongError when name exceeds 34 chars', () => {
    // "averylongprefixstring" (21) + "-" + "orchestrator" (12) = 34 — just OK
    // Add one more char to tip over.
    const longPrefix = 'averylongprefixstringx'; // 22 chars → 22+1+12 = 35
    expect(() =>
      buildManifest({
        prefix: longPrefix,
        persona: 'orchestrator',
        callbackUrl: 'http://localhost:3000/callback',
      }),
    ).toThrow(ManifestNameTooLongError);
  });

  it('ManifestNameTooLongError includes the offending name in its message', () => {
    const prefix = 'averylongprefixstringx';
    const offendingName = `${prefix}-orchestrator`;
    let caught: unknown;
    try {
      buildManifest({
        prefix,
        persona: 'orchestrator',
        callbackUrl: 'http://localhost:3000/callback',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ManifestNameTooLongError);
    const err = caught as ManifestNameTooLongError;
    expect(err.message).toContain(offendingName);
    expect(err.appName).toBe(offendingName);
  });

  it('accepts a name of exactly 34 characters without throwing', () => {
    // "averylongprefixstring" (21) + "-" + "orchestrator" (12) = 34
    expect(() =>
      buildManifest({
        prefix: 'averylongprefixstring',
        persona: 'orchestrator',
        callbackUrl: 'http://localhost:3000/callback',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildManifest — permissions
// ---------------------------------------------------------------------------

describe('buildManifest — permissions', () => {
  it('default_permissions matches APP_PERMISSIONS byte-for-byte', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
    });
    expect(manifest.default_permissions).toStrictEqual(APP_PERMISSIONS);
  });

  it('default_permissions includes wiki:write (required for per-repo KB)', () => {
    // README §"GitHub App setup" lists Wiki as required — not optional — because
    // every persona App needs wiki write to push KB page updates.  This assertion
    // is an explicit, README-anchored lock so the permission cannot be silently
    // dropped from APP_PERMISSIONS without a test failure.
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
    });
    expect(manifest.default_permissions.wiki).toBe('write');
  });

  it('default_events is an empty array', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
    });
    expect(manifest.default_events).toHaveLength(0);
    expect(Array.isArray(manifest.default_events)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildManifest — shape
// ---------------------------------------------------------------------------

describe('buildManifest — shape', () => {
  it('public is false', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
    });
    expect(manifest.public).toBe(false);
  });

  it('setup_on_update is false', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
    });
    expect(manifest.setup_on_update).toBe(false);
  });

  it('callback_urls is an empty array', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
    });
    expect(manifest.callback_urls).toEqual([]);
  });

  it('redirect_url matches callbackUrl', () => {
    const callbackUrl = 'http://localhost:9876/oauth/callback';
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl,
    });
    expect(manifest.redirect_url).toBe(callbackUrl);
  });

  it('does not include hook_attributes', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
    }) as unknown as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('hook_attributes');
  });

  it('does not include setup_url', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
    }) as unknown as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('setup_url');
  });
});

// ---------------------------------------------------------------------------
// manifestStartUrl
// ---------------------------------------------------------------------------

describe('manifestStartUrl', () => {
  it('returns personal URL for ownerType="user"', () => {
    const url = manifestStartUrl({ ownerType: 'user', state: 'abc123' });
    expect(url).toBe('https://github.com/settings/apps/new?state=abc123');
  });

  it('returns org-scoped URL for ownerType="org"', () => {
    const url = manifestStartUrl({
      ownerType: 'org',
      orgLogin: 'acme-corp',
      state: 'xyz789',
    });
    expect(url).toBe(
      'https://github.com/organizations/acme-corp/settings/apps/new?state=xyz789',
    );
  });

  it('URL-encodes the state parameter', () => {
    const url = manifestStartUrl({
      ownerType: 'user',
      state: 'hello world+special=chars&more',
    });
    expect(url).toContain('state=hello%20world%2Bspecial%3Dchars%26more');
  });

  it('throws when ownerType="org" but orgLogin is missing', () => {
    let caught: unknown;
    try {
      manifestStartUrl({ ownerType: 'org', state: 'abc' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrgLoginRequiredError);
    expect((caught as OrgLoginRequiredError).message).toContain('orgLogin is required');
  });

  it('throws InvalidGithubLoginError when orgLogin is invalid (contains space)', () => {
    expect(() =>
      manifestStartUrl({ ownerType: 'org', orgLogin: 'foo bar', state: 's' }),
    ).toThrow(InvalidGithubLoginError);
  });
});

// ---------------------------------------------------------------------------
// validateGithubLogin
// ---------------------------------------------------------------------------

describe('validateGithubLogin', () => {
  // Valid logins — must NOT throw
  it.each([
    ['agenti-fy', 'hyphen in middle'],
    ['github', 'simple lowercase'],
    ['Acme-Corp', 'mixed case with hyphen'],
    ['a', 'single character'],
    ['a'.repeat(38) + 'z', 'exactly 39 characters'],
  ])('does not throw for valid login %s (%s)', (login) => {
    expect(() => validateGithubLogin(login)).not.toThrow();
  });

  // Invalid logins — must throw InvalidGithubLoginError
  it.each([
    ['', 'empty string'],
    ['a'.repeat(40), 'more than 39 characters'],
    ['foo bar', 'contains whitespace'],
    ['foo/bar', 'contains slash'],
    ['foo.bar', 'contains dot'],
    ['foo%bar', 'contains percent'],
    ['foo_bar', 'contains underscore'],
    ['-foo', 'leading hyphen'],
    ['foo-', 'trailing hyphen'],
    ['foo--bar', 'consecutive hyphens'],
  ])('throws InvalidGithubLoginError for invalid login "%s" (%s)', (login) => {
    expect(() => validateGithubLogin(login)).toThrow(InvalidGithubLoginError);
  });

  it('thrown error is an instanceof InvalidGithubLoginError', () => {
    let caught: unknown;
    try {
      validateGithubLogin('bad login!');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidGithubLoginError);
  });

  it('thrown error has .login set to the offending input', () => {
    const offending = 'foo--bar';
    let caught: unknown;
    try {
      validateGithubLogin(offending);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidGithubLoginError);
    expect((caught as InvalidGithubLoginError).login).toBe(offending);
  });

  it('thrown error .message contains the offending input', () => {
    const offending = '-leading-hyphen';
    let caught: unknown;
    try {
      validateGithubLogin(offending);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidGithubLoginError);
    expect((caught as InvalidGithubLoginError).message).toContain(offending);
  });
});
