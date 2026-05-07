import { describe, it, expect } from 'vitest';
import { BUILTIN_PERSONAS } from '@agentify/shared';
import { APP_PERMISSIONS } from './personas.js';
import {
  buildManifest,
  manifestStartUrl,
  ManifestNameTooLongError,
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
        ownerType: 'user',
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
        ownerType: 'user',
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
        ownerType: 'user',
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
        ownerType: 'user',
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
      ownerType: 'user',
    });
    expect(manifest.default_permissions).toStrictEqual(APP_PERMISSIONS);
  });

  it('default_events is an empty array', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
      ownerType: 'user',
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
      ownerType: 'user',
    });
    expect(manifest.public).toBe(false);
  });

  it('setup_on_update is false', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
      ownerType: 'user',
    });
    expect(manifest.setup_on_update).toBe(false);
  });

  it('callback_urls is an empty array', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
      ownerType: 'user',
    });
    expect(manifest.callback_urls).toEqual([]);
  });

  it('redirect_url matches callbackUrl', () => {
    const callbackUrl = 'http://localhost:9876/oauth/callback';
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl,
      ownerType: 'user',
    });
    expect(manifest.redirect_url).toBe(callbackUrl);
  });

  it('does not include hook_attributes', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
      ownerType: 'user',
    }) as unknown as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('hook_attributes');
  });

  it('does not include setup_url', () => {
    const manifest = buildManifest({
      prefix: 'test',
      persona: 'theorist',
      callbackUrl: 'http://localhost:3000/callback',
      ownerType: 'user',
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
    expect(() =>
      manifestStartUrl({ ownerType: 'org', state: 'abc' }),
    ).toThrow('orgLogin is required');
  });
});
