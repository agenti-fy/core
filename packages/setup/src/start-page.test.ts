import { describe, it, expect } from 'vitest';
import type { GithubAppManifest } from './manifest.js';
import { renderStartPage, escapeHtml } from './start-page.js';
import { APP_PERMISSIONS, APP_DEFAULT_EVENTS } from './personas.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Build a realistic manifest fixture. */
function makeManifest(callbackUrl = 'http://127.0.0.1:52000/callback'): GithubAppManifest {
  return {
    name: 'acme-orchestrator',
    url: 'https://github.com/agenti-fy/core',
    redirect_url: callbackUrl,
    callback_urls: [],
    public: false,
    setup_on_update: false,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_DEFAULT_EVENTS,
  };
}

/** Extract the value of the hidden manifest input from the rendered HTML. */
function extractManifestValue(html: string): string {
  // Match: <input type="hidden" name="manifest" value="...">
  // The value attribute is HTML-attribute-encoded; we need to undo &quot; → "
  const match = html.match(/<input[^>]+name="manifest"[^>]+value="([^"]*)"[^>]*>/);
  if (!match || match[1] === undefined) {
    throw new Error('Could not find manifest hidden input in rendered HTML');
  }
  // Decode the five HTML entities used by escapeHtml
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ── escapeHtml unit tests ─────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes & to &amp;', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes < to &lt;', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes > to &gt;', () => {
    expect(escapeHtml('1 > 0')).toBe('1 &gt; 0');
  });

  it('escapes " to &quot;', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it("escapes ' to &#39;", () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('leaves plain strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes all five special chars in a single string', () => {
    expect(escapeHtml(`<a href="#" onclick="alert('xss')">click & go</a>`)).toBe(
      `&lt;a href=&quot;#&quot; onclick=&quot;alert(&#39;xss&#39;)&quot;&gt;click &amp; go&lt;/a&gt;`,
    );
  });
});

// ── renderStartPage ───────────────────────────────────────────────────────

describe('renderStartPage', () => {
  describe('manifest round-trip', () => {
    it('embeds the manifest JSON and it deep-equals the input when parsed back', () => {
      const manifest = makeManifest();
      const html = renderStartPage({
        manifest,
        manifestStartUrl: 'https://github.com/settings/apps/new?state=abc123',
        persona: 'orchestrator',
        appName: 'acme-orchestrator',
      });

      const recovered = JSON.parse(extractManifestValue(html)) as unknown;
      expect(recovered).toEqual(manifest);
    });

    it('preserves manifest fields through HTML-encoding round-trip', () => {
      const manifest = makeManifest('http://127.0.0.1:0/callback?foo=bar&baz=qux');
      const html = renderStartPage({
        manifest,
        manifestStartUrl: 'https://github.com/settings/apps/new?state=xyz',
        persona: 'tinkerer',
        appName: 'acme-tinkerer',
      });

      const recovered = JSON.parse(extractManifestValue(html)) as typeof manifest;
      expect(recovered.redirect_url).toBe(manifest.redirect_url);
      expect(recovered.default_permissions).toEqual(manifest.default_permissions);
    });
  });

  describe('HTML injection safety', () => {
    it('HTML-injection attempt in appName does not break form structure', () => {
      const manifest = makeManifest();
      const html = renderStartPage({
        manifest,
        manifestStartUrl: 'https://github.com/settings/apps/new?state=x',
        persona: 'scribe',
        appName: '</form><script>alert(1)</script>',
      });

      // The raw injection string must not appear outside the actual single form tag.
      // We verify by checking that </form> only appears as the real closing tag
      // at the end of the document, i.e. the injected </form> is escaped.
      const formCloseMatches = html.match(/<\/form>/g);
      // There should be exactly one </form> — the real one.
      expect(formCloseMatches?.length).toBe(1);

      // The escaped version of the injection must appear somewhere (proving it
      // was correctly encoded rather than dropped).
      expect(html).toContain('&lt;/form&gt;');
    });

    it('HTML-injection attempt in manifestStartUrl does not inject attributes', () => {
      const manifest = makeManifest();
      const html = renderStartPage({
        manifest,
        manifestStartUrl: 'https://github.com/settings/apps/new?state=x" onsubmit="alert(1)',
        persona: 'crafter',
        appName: 'acme-crafter',
      });

      // The raw unescaped onsubmit must not appear as an HTML attribute.
      expect(html).not.toContain('onsubmit="alert(1)');
      // The escaped form must be present in the action attribute value.
      expect(html).toContain('&quot;');
    });
  });

  describe('manifest start URL variants', () => {
    it('renders correctly with a personal manifestStartUrl', () => {
      const manifest = makeManifest();
      const personalUrl = 'https://github.com/settings/apps/new?state=personal123';
      const html = renderStartPage({
        manifest,
        manifestStartUrl: personalUrl,
        persona: 'optimizer',
        appName: 'acme-optimizer',
      });

      // The form action should include the escaped personal URL.
      expect(html).toContain(`action="${escapeHtml(personalUrl)}"`);
    });

    it('renders correctly with an org manifestStartUrl', () => {
      const manifest = makeManifest();
      const orgUrl = 'https://github.com/organizations/acme-org/settings/apps/new?state=org456';
      const html = renderStartPage({
        manifest,
        manifestStartUrl: orgUrl,
        persona: 'conductor',
        appName: 'acme-conductor',
      });

      // The form action should include the escaped org URL.
      expect(html).toContain(`action="${escapeHtml(orgUrl)}"`);
      // Both should round-trip manifests correctly.
      const recovered = JSON.parse(extractManifestValue(html)) as unknown;
      expect(recovered).toEqual(manifest);
    });
  });

  describe('page structure', () => {
    it('is a complete HTML document with DOCTYPE', () => {
      const html = renderStartPage({
        manifest: makeManifest(),
        manifestStartUrl: 'https://github.com/settings/apps/new?state=s',
        persona: 'glue',
        appName: 'acme-glue',
      });

      expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
      expect(html).toContain('<html');
      expect(html).toContain('</html>');
    });

    it('contains the auto-submit script', () => {
      const html = renderStartPage({
        manifest: makeManifest(),
        manifestStartUrl: 'https://github.com/settings/apps/new?state=s',
        persona: 'skeptic',
        appName: 'acme-skeptic',
      });

      expect(html).toContain("document.getElementById('manifest-form').submit()");
    });

    it('contains a noscript fallback with a submit button', () => {
      const html = renderStartPage({
        manifest: makeManifest(),
        manifestStartUrl: 'https://github.com/settings/apps/new?state=s',
        persona: 'theorist',
        appName: 'acme-theorist',
      });

      expect(html).toContain('<noscript>');
      // There should be a submit button inside noscript.
      expect(html).toMatch(/<button[^>]+type="submit"/);
    });

    it('displays the persona name in the human-readable summary', () => {
      const html = renderStartPage({
        manifest: makeManifest(),
        manifestStartUrl: 'https://github.com/settings/apps/new?state=s',
        persona: 'orchestrator',
        appName: 'acme-orchestrator',
      });

      expect(html).toContain('orchestrator');
    });

    it('displays the App name in the human-readable summary', () => {
      const html = renderStartPage({
        manifest: makeManifest(),
        manifestStartUrl: 'https://github.com/settings/apps/new?state=s',
        persona: 'orchestrator',
        appName: 'acme-orchestrator',
      });

      expect(html).toContain('acme-orchestrator');
    });

    it('displays the permissions in the human-readable summary', () => {
      const html = renderStartPage({
        manifest: makeManifest(),
        manifestStartUrl: 'https://github.com/settings/apps/new?state=s',
        persona: 'tinkerer',
        appName: 'acme-tinkerer',
      });

      // At least one permission from APP_PERMISSIONS should appear.
      expect(html).toContain('contents');
      expect(html).toContain('issues');
    });

    it('displays the callback URL in the human-readable summary', () => {
      const callbackUrl = 'http://127.0.0.1:52001/callback';
      const html = renderStartPage({
        manifest: makeManifest(callbackUrl),
        manifestStartUrl: 'https://github.com/settings/apps/new?state=s',
        persona: 'tinkerer',
        appName: 'acme-tinkerer',
      });

      expect(html).toContain(escapeHtml(callbackUrl));
    });

    it('has a form with id="manifest-form" and correct method + action', () => {
      const startUrl = 'https://github.com/settings/apps/new?state=abc';
      const html = renderStartPage({
        manifest: makeManifest(),
        manifestStartUrl: startUrl,
        persona: 'crafter',
        appName: 'acme-crafter',
      });

      expect(html).toContain('id="manifest-form"');
      expect(html).toContain('method="post"');
      expect(html).toContain(`action="${escapeHtml(startUrl)}"`);
    });

    it('has a hidden input named "manifest"', () => {
      const html = renderStartPage({
        manifest: makeManifest(),
        manifestStartUrl: 'https://github.com/settings/apps/new?state=s',
        persona: 'scribe',
        appName: 'acme-scribe',
      });

      expect(html).toContain('type="hidden"');
      expect(html).toContain('name="manifest"');
    });
  });
});
