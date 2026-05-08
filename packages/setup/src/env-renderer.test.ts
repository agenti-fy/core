import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { BUILTIN_PERSONAS } from '@agenti-fy/shared';
import { renderEnv, WizardConfigSchema, type WizardConfig } from './env-renderer.js';
import { parseDotenv } from './dotenv.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Make a realistic multi-line PEM for a given label (not a real key). */
function fakePem(label: string): string {
  return `-----BEGIN RSA PRIVATE KEY-----\nMII${label.toUpperCase().slice(0, 8).padEnd(8, 'A')}\n-----END RSA PRIVATE KEY-----`;
}

// ── Fixture config (deterministic) ────────────────────────────────────────

const FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

/** Build a complete WizardConfig for the golden fixture. */
function makeFixtureConfig(): WizardConfig {
  const personaEntries = BUILTIN_PERSONAS.map((name, idx) => {
    const n = (idx + 1) * 10;
    return [
      name,
      {
        appId: String(1000 + n),
        installationId: String(2000 + n),
        privateKey: fakePem(name),
        githubUser: `${name}-bot`,
      },
    ] as const;
  });

  return WizardConfigSchema.parse({
    prefix: 'acme',
    repo: { owner: 'acme', name: 'sandbox' },
    coordinator: {
      appId: '1001',
      installationId: '2001',
      privateKey: fakePem('coordinator'),
      githubUser: 'coord-bot',
    },
    personas: Object.fromEntries(personaEntries),
    anthropic: { kind: 'api_key', value: 'sk-ant-example' },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('renderEnv', () => {
  describe('round-trip: render → parse → assert', () => {
    it('produces all 41 required keys (coordinator 4 + anthropic 1 + 9×4 personas)', () => {
      const config = makeFixtureConfig();
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      const parsed = parseDotenv(output);

      // Coordinator
      expect(parsed['GITHUB_APP_ID']).toBe('1001');
      expect(parsed['GITHUB_APP_INSTALLATION_ID']).toBe('2001');
      expect(parsed['GITHUB_USER']).toBe('coord-bot');

      // Anthropic
      expect(parsed['ANTHROPIC_API_KEY']).toBe('sk-ant-example');

      // Per-persona
      BUILTIN_PERSONAS.forEach((name, idx) => {
        const prefix = name.toUpperCase();
        const n = (idx + 1) * 10;
        expect(parsed[`${prefix}_GITHUB_APP_ID`]).toBe(String(1000 + n));
        expect(parsed[`${prefix}_GITHUB_APP_INSTALLATION_ID`]).toBe(String(2000 + n));
        expect(parsed[`${prefix}_GITHUB_USER`]).toBe(`${name}-bot`);
      });

      // Total key count
      expect(Object.keys(parsed).length).toBeGreaterThanOrEqual(41);
    });

    it('preserves PEM bodies byte-for-byte through the round-trip', () => {
      const config = makeFixtureConfig();
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      const parsed = parseDotenv(output);

      // Coordinator PEM
      expect(parsed['GITHUB_APP_PRIVATE_KEY']).toBe(fakePem('coordinator'));

      // Per-persona PEMs
      for (const name of BUILTIN_PERSONAS) {
        const prefix = name.toUpperCase();
        expect(parsed[`${prefix}_GITHUB_APP_PRIVATE_KEY`]).toBe(fakePem(name));
      }
    });

    it('preserves PEM with embedded single-quotes through the round-trip', () => {
      const config = WizardConfigSchema.parse({
        ...makeFixtureConfig(),
        coordinator: {
          ...makeFixtureConfig().coordinator,
          privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMII'weird'key\n-----END RSA PRIVATE KEY-----",
        },
      });
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      const parsed = parseDotenv(output);
      expect(parsed['GITHUB_APP_PRIVATE_KEY']).toBe(
        "-----BEGIN RSA PRIVATE KEY-----\nMII'weird'key\n-----END RSA PRIVATE KEY-----",
      );
    });

    it('renders CLAUDE_CODE_OAUTH_TOKEN when anthropic.kind is oauth_token', () => {
      const config = WizardConfigSchema.parse({
        ...makeFixtureConfig(),
        anthropic: { kind: 'oauth_token', value: 'claude-oauth-tok' },
      });
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      const parsed = parseDotenv(output);
      expect(parsed['CLAUDE_CODE_OAUTH_TOKEN']).toBe('claude-oauth-tok');
      expect('ANTHROPIC_API_KEY' in parsed).toBe(false);
    });

    it('includes tunable key-value pairs when provided', () => {
      const config = WizardConfigSchema.parse({
        ...makeFixtureConfig(),
        tunables: { LOG_LEVEL: 'debug', WORK_POLL_S: 10 },
      });
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      const parsed = parseDotenv(output);
      expect(parsed['LOG_LEVEL']).toBe('debug');
      expect(parsed['WORK_POLL_S']).toBe('10');
    });

    it('does not render webhook_secret even if present in config (not in schema)', () => {
      // webhook_secret is not part of WizardConfig so it cannot appear in output.
      const config = makeFixtureConfig();
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      expect(output).not.toContain('WEBHOOK_SECRET');
      expect(output).not.toContain('webhook_secret');
    });
  });

  describe('snapshot: matches golden fixture', () => {
    it('output matches packages/setup/test/fixtures/example.env', () => {
      const fixtureDir = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'test',
        'fixtures',
      );
      const golden = readFileSync(join(fixtureDir, 'example.env'), 'utf8');
      const config = makeFixtureConfig();
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      expect(output).toBe(golden);
    });
  });

  describe('WizardConfigSchema validation', () => {
    it('rejects configs missing any of the 9 required personas', () => {
      const base = makeFixtureConfig();
      // Omit one persona (orchestrator)
      const { orchestrator: _omitted, ...rest } = base.personas;
      expect(() =>
        WizardConfigSchema.parse({ ...base, personas: rest }),
      ).toThrow();
    });

    it('rejects configs where anthropic.kind is neither api_key nor oauth_token', () => {
      const base = makeFixtureConfig();
      expect(() =>
        WizardConfigSchema.parse({
          ...base,
          anthropic: { kind: 'both', value: 'x' },
        }),
      ).toThrow();
    });

    it('accepts config with only api_key set', () => {
      const config = WizardConfigSchema.parse({
        ...makeFixtureConfig(),
        anthropic: { kind: 'api_key', value: 'sk-api' },
      });
      expect(config.anthropic.kind).toBe('api_key');
    });

    it('accepts config with only oauth_token set', () => {
      const config = WizardConfigSchema.parse({
        ...makeFixtureConfig(),
        anthropic: { kind: 'oauth_token', value: 'tok' },
      });
      expect(config.anthropic.kind).toBe('oauth_token');
    });

    it('rejects empty strings in coordinator fields', () => {
      const base = makeFixtureConfig();
      expect(() =>
        WizardConfigSchema.parse({
          ...base,
          coordinator: { ...base.coordinator, appId: '' },
        }),
      ).toThrow();
    });

    describe('tunable key validation', () => {
      it('accepts valid uppercase env-var keys', () => {
        expect(() =>
          WizardConfigSchema.parse({
            ...makeFixtureConfig(),
            tunables: { LOG_LEVEL: 'debug', WORK_POLL_S: 30, _HIDDEN: 'x' },
          }),
        ).not.toThrow();
      });

      it('rejects keys containing a newline character', () => {
        expect(() =>
          WizardConfigSchema.parse({
            ...makeFixtureConfig(),
            tunables: { ['INJECT\nED']: 'bad' },
          }),
        ).toThrow();
      });

      it('rejects keys containing an equals sign', () => {
        expect(() =>
          WizardConfigSchema.parse({
            ...makeFixtureConfig(),
            tunables: { ['KEY=EVIL']: 'bad' },
          }),
        ).toThrow();
      });

      it('rejects lowercase keys', () => {
        expect(() =>
          WizardConfigSchema.parse({
            ...makeFixtureConfig(),
            tunables: { log_level: 'debug' },
          }),
        ).toThrow();
      });

      it('rejects keys that start with a digit', () => {
        expect(() =>
          WizardConfigSchema.parse({
            ...makeFixtureConfig(),
            tunables: { '1BAD': 'value' },
          }),
        ).toThrow();
      });

      it('rejects empty-string keys', () => {
        expect(() =>
          WizardConfigSchema.parse({
            ...makeFixtureConfig(),
            tunables: { '': 'value' },
          }),
        ).toThrow();
      });
    });
  });

  describe('output ordering', () => {
    it('lists personas in BUILTIN_PERSONAS order', () => {
      const config = makeFixtureConfig();
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      const positions = BUILTIN_PERSONAS.map((name) => {
        const prefix = name.toUpperCase();
        return output.indexOf(`${prefix}_GITHUB_APP_ID=`);
      });
      // Each persona's position should be strictly after the previous one.
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1] as number);
      }
    });

    it('places coordinator block before all persona blocks', () => {
      const config = makeFixtureConfig();
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      const coordPos = output.indexOf('GITHUB_APP_ID=');
      const firstPersonaPos = output.indexOf('ORCHESTRATOR_GITHUB_APP_ID=');
      expect(coordPos).toBeLessThan(firstPersonaPos);
    });

    it('places Anthropic block before persona blocks', () => {
      const config = makeFixtureConfig();
      const output = renderEnv(config, { timestamp: FIXTURE_TIMESTAMP });
      const anthropicPos = output.indexOf('ANTHROPIC_API_KEY=');
      const firstPersonaPos = output.indexOf('ORCHESTRATOR_GITHUB_APP_ID=');
      expect(anthropicPos).toBeLessThan(firstPersonaPos);
    });
  });
});
