/**
 * finalize.test.ts — unit tests for the .env write driver and verify subcommand.
 *
 * All filesystem and network I/O is injected via FinalizeDeps / VerifyDeps so
 * no real disk or GitHub API calls are made.  I/O streams use PassThrough pairs
 * with chained-setImmediate line feeding (see KB-Tinkerer.md).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { BUILTIN_PERSONAS } from '@agenti-fy/shared';
import type { Octokit } from '@octokit/rest';
import { runFinalize, runVerify, IncompleteStateError } from './finalize.js';
import type { IoStreams } from '../prompts.js';
import type { WizardState, PersonaCreds } from '../state.js';
import { renderEnv } from '../env-renderer.js';
import { WizardConfigSchema } from '../env-renderer.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build an IoStreams pair fed by the given lines, one per tick. */
function makeIo(lines: string[]): IoStreams & { output: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const remaining = [...lines];
  function writeNext(): void {
    const line = remaining.shift();
    if (line !== undefined) {
      stdin.write(`${line}\n`);
      setImmediate(writeNext);
    } else {
      stdin.end();
    }
  }
  setImmediate(writeNext);

  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  return {
    stdin,
    stdout,
    output: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Build an IoStreams pair that immediately sends EOF (no input). */
function makeEofIo(): IoStreams & { output: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  setImmediate(() => stdin.end());
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    stdin,
    stdout,
    output: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Make a realistic multi-line PEM for a given label (not a real key). */
function fakePem(label: string): string {
  return `-----BEGIN RSA PRIVATE KEY-----\nMII${label.toUpperCase().slice(0, 8).padEnd(8, 'A')}\n-----END RSA PRIVATE KEY-----`;
}

/** Build a full PersonaCreds object for testing. */
function fakePersonaCreds(name: string, index: number): PersonaCreds {
  return {
    appId: 1000 + index,
    slug: `test-${name}`,
    name: `Test ${name}`,
    htmlUrl: `https://github.com/apps/test-${name}`,
    pem: fakePem(name),
    clientId: `Iv1.${name.slice(0, 8)}`,
    clientSecret: `secret-${name}`,
    webhookSecret: null,
    installationId: 2000 + index,
    githubUser: `test-${name}[bot]`,
  };
}

/** Build a fully-populated WizardState for finalize testing. */
function makeFullState(overrides: Partial<WizardState> = {}): WizardState {
  const personaEntries = BUILTIN_PERSONAS.map((name, idx) => [
    name,
    fakePersonaCreds(name, idx + 1),
  ]);
  const coordinatorCreds = fakePersonaCreds('coordinator', 0);

  return {
    version: 2,
    prefix: 'test-prefix',
    repo: { owner: 'alice', name: 'sandbox' },
    ownerType: 'personal',
    coordinator: coordinatorCreds,
    personas: Object.fromEntries(personaEntries),
    anthropic: { kind: 'api_key', value: 'sk-ant-testkey' },
    tunables: { LOG_LEVEL: 'info', WORK_POLL_S: 30 },
    ...overrides,
  };
}

/** Build a partial WizardState (no apps created, no anthropic). */
function makeIncompleteState(): WizardState {
  return {
    version: 2,
    prefix: 'test-prefix',
    repo: { owner: 'alice', name: 'sandbox' },
    ownerType: 'personal',
    coordinator: undefined,
    personas: Object.fromEntries(BUILTIN_PERSONAS.map((p) => [p, undefined])),
    anthropic: undefined,
    tunables: undefined,
  };
}

// ── runFinalize tests ─────────────────────────────────────────────────────────

describe('runFinalize', () => {
  describe('dry-run path', () => {
    it('prints the rendered .env to stdout and does not write any file', async () => {
      const io = makeEofIo();
      const writtenFiles: string[] = [];

      const result = await runFinalize({
        state: makeFullState(),
        io,
        dryRun: true,
        writeEnvFile: async (p) => {
          writtenFiles.push(p);
        },
      });

      const out = io.output();
      // Should contain the rendered .env content
      expect(out).toContain('GITHUB_APP_ID=');
      expect(out).toContain('ANTHROPIC_API_KEY=');
      expect(out).toContain('ORCHESTRATOR_GITHUB_APP_ID=');
      // Should not have written any files
      expect(writtenFiles).toHaveLength(0);
      // Should return an envPath
      expect(result.envPath).toBeTruthy();
    });
  });

  describe('write to new file', () => {
    it('writes the .env to the specified envOut path when file does not exist', async () => {
      const io = makeEofIo();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-test-'));
      const envPath = path.join(tmpDir, '.env');

      try {
        const result = await runFinalize({
          state: makeFullState(),
          io,
          envOut: envPath,
          fileExists: async () => false,
          writeEnvFile: async (p, content) => {
            await fs.writeFile(p, content, 'utf8');
          },
        });

        expect(result.envPath).toBe(envPath);
        const written = await fs.readFile(envPath, 'utf8');
        expect(written).toContain('GITHUB_APP_ID=');
        expect(written).toContain('ANTHROPIC_API_KEY=');
        expect(written).toContain('ORCHESTRATOR_GITHUB_APP_ID=');
        // Should have 9 persona blocks
        for (const p of BUILTIN_PERSONAS) {
          expect(written).toContain(`${p.toUpperCase()}_GITHUB_APP_ID=`);
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('defaults envOut to cwd/.env when not specified', async () => {
      const io = makeEofIo();
      const writtenPaths: string[] = [];

      await runFinalize({
        state: makeFullState(),
        io,
        cwd: () => '/fake/cwd',
        fileExists: async () => false,
        writeEnvFile: async (p) => {
          writtenPaths.push(p);
        },
        // Suppress the docker-compose.yml + souls/ side-effect so the test
        // doesn't try to mkdir under a fake path. Compose-write coverage
        // lives in compose.test.ts and the runFinalize tests below that
        // explicitly opt in.
        noCompose: true,
      });

      expect(writtenPaths).toEqual(['/fake/cwd/.env']);
    });

    it('prints next-steps banner after writing', async () => {
      const io = makeEofIo();

      await runFinalize({
        state: makeFullState(),
        io,
        cwd: () => '/fake/cwd',
        fileExists: async () => false,
        writeEnvFile: async () => void 0,
        noCompose: true,
      });

      const out = io.output();
      expect(out).toContain('docker compose up -d --build');
      expect(out).toContain('pnpm e2e:doctor');
    });
  });

  describe('compose + souls write', () => {
    it('writes docker-compose.yml + souls/<persona>.md alongside .env', async () => {
      const io = makeEofIo();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-compose-'));
      const envPath = path.join(tmpDir, '.env');

      try {
        await runFinalize({
          state: makeFullState(),
          io,
          envOut: envPath,
          imageTag: '0.3.1',
          // Stub the bundled-soul loader so the test doesn't depend on a
          // built dist/souls/ tree being present (CI runs tests before build).
          loadBundledSouls: async () =>
            Object.freeze({
              orchestrator: '---\nname: orchestrator\n---\n',
              conductor: '---\nname: conductor\n---\n',
              theorist: '---\nname: theorist\n---\n',
              tinkerer: '---\nname: tinkerer\n---\n',
              optimizer: '---\nname: optimizer\n---\n',
              glue: '---\nname: glue\n---\n',
              skeptic: '---\nname: skeptic\n---\n',
              crafter: '---\nname: crafter\n---\n',
              scribe: '---\nname: scribe\n---\n',
            }),
          loadBundledPrometheusYaml: async () =>
            "global:\n  scrape_interval: 15s\nscrape_configs:\n  - job_name: 'coordinator'\n",
        });

        // .env landed.
        const envStat = await fs.stat(envPath);
        expect(envStat.isFile()).toBe(true);

        // docker-compose.yml landed and references the pinned tag.
        const composePath = path.join(tmpDir, 'docker-compose.yml');
        const composeContent = await fs.readFile(composePath, 'utf8');
        expect(composeContent).toContain('image: ghcr.io/agenti-fy/coordinator:0.3.1');
        expect(composeContent).toContain('image: ghcr.io/agenti-fy/agent:0.3.1');
        expect(composeContent).not.toContain('build:');

        // prometheus.yml landed (always emitted; profile-gated in compose
        // means inert by default but `docker compose --profile monitoring up`
        // works out of the box).
        const promPath = path.join(tmpDir, 'prometheus.yml');
        const promContent = await fs.readFile(promPath, 'utf8');
        expect(promContent).toContain("job_name: 'coordinator'");

        // All nine soul files landed.
        const soulsDir = path.join(tmpDir, 'souls');
        const personas = [
          'orchestrator', 'conductor', 'theorist', 'tinkerer', 'optimizer',
          'glue', 'skeptic', 'crafter', 'scribe',
        ];
        for (const p of personas) {
          const soulPath = path.join(soulsDir, `${p}.md`);
          const content = await fs.readFile(soulPath, 'utf8');
          expect(content, `${p} soul`).toContain(`name: ${p}`);
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('does NOT overwrite an existing prometheus.yml', async () => {
      const io = makeEofIo();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-promcollision-'));
      const envPath = path.join(tmpDir, '.env');
      const promPath = path.join(tmpDir, 'prometheus.yml');

      try {
        // Pre-create prometheus.yml with operator-customized content.
        await fs.writeFile(promPath, '# OPERATOR CUSTOM PROMETHEUS — do not touch\n');

        await runFinalize({
          state: makeFullState(),
          io,
          envOut: envPath,
          imageTag: '0.3.1',
          loadBundledSouls: async () =>
            Object.freeze({
              orchestrator: 'orch\n', conductor: 'cond\n', theorist: 'theo\n',
              tinkerer: 'tink\n', optimizer: 'opt\n', glue: 'glue\n',
              skeptic: 'skep\n', crafter: 'craft\n', scribe: 'scribe\n',
            }),
          loadBundledPrometheusYaml: async () => 'WIZARD_DEFAULT_SHOULD_NOT_OVERWRITE',
        });

        // Operator's prometheus.yml is preserved.
        const after = await fs.readFile(promPath, 'utf8');
        expect(after).toBe('# OPERATOR CUSTOM PROMETHEUS — do not touch\n');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('continues writing other artifacts when prometheus.yml loader fails (non-fatal)', async () => {
      const io = makeEofIo();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-promfail-'));
      const envPath = path.join(tmpDir, '.env');

      try {
        await runFinalize({
          state: makeFullState(),
          io,
          envOut: envPath,
          imageTag: '0.3.1',
          loadBundledSouls: async () =>
            Object.freeze({
              orchestrator: 'orch\n', conductor: 'cond\n', theorist: 'theo\n',
              tinkerer: 'tink\n', optimizer: 'opt\n', glue: 'glue\n',
              skeptic: 'skep\n', crafter: 'craft\n', scribe: 'scribe\n',
            }),
          loadBundledPrometheusYaml: async () => {
            throw new Error('simulated broken-package failure');
          },
        });

        // .env, compose, and souls all landed despite prometheus.yml load failing.
        await expect(fs.stat(envPath)).resolves.toBeDefined();
        await expect(fs.stat(path.join(tmpDir, 'docker-compose.yml'))).resolves.toBeDefined();
        await expect(fs.stat(path.join(tmpDir, 'souls', 'orchestrator.md'))).resolves.toBeDefined();
        // prometheus.yml was NOT written (loader threw).
        await expect(fs.stat(path.join(tmpDir, 'prometheus.yml'))).rejects.toThrow();
        // Operator-visible warning that explains what's broken.
        expect(io.output()).toMatch(/Could not write .*prometheus\.yml/);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('skips compose + souls writes when --no-compose is passed', async () => {
      const io = makeEofIo();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-nocompose-'));
      const envPath = path.join(tmpDir, '.env');

      try {
        await runFinalize({
          state: makeFullState(),
          io,
          envOut: envPath,
          noCompose: true,
        });

        // .env still written.
        await expect(fs.stat(envPath)).resolves.toBeDefined();
        // No compose file, no souls dir.
        await expect(fs.stat(path.join(tmpDir, 'docker-compose.yml'))).rejects.toThrow();
        await expect(fs.stat(path.join(tmpDir, 'souls'))).rejects.toThrow();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('does NOT overwrite an existing docker-compose.yml or soul file', async () => {
      const io = makeEofIo();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-collision-'));
      const envPath = path.join(tmpDir, '.env');
      const composePath = path.join(tmpDir, 'docker-compose.yml');
      const soulsDir = path.join(tmpDir, 'souls');
      const skepticSoulPath = path.join(soulsDir, 'skeptic.md');

      try {
        // Pre-create compose + ONE soul file with sentinel content.
        await fs.writeFile(composePath, '# OPERATOR-CUSTOMIZED — DO NOT TOUCH\n');
        await fs.mkdir(soulsDir);
        await fs.writeFile(skepticSoulPath, '# OPERATOR-CUSTOMIZED SKEPTIC\n');

        await runFinalize({
          state: makeFullState(),
          io,
          envOut: envPath,
          imageTag: '0.3.1',
          loadBundledSouls: async () =>
            Object.freeze({
              orchestrator: 'orch\n',
              conductor: 'cond\n',
              theorist: 'theo\n',
              tinkerer: 'tink\n',
              optimizer: 'opt\n',
              glue: 'glue\n',
              skeptic: 'NEW-SKEPTIC-SHOULD-NOT-OVERWRITE\n',
              crafter: 'craft\n',
              scribe: 'scribe\n',
            }),
        });

        // Compose untouched.
        const composeAfter = await fs.readFile(composePath, 'utf8');
        expect(composeAfter).toBe('# OPERATOR-CUSTOMIZED — DO NOT TOUCH\n');
        // Skeptic soul untouched.
        const skepticAfter = await fs.readFile(skepticSoulPath, 'utf8');
        expect(skepticAfter).toBe('# OPERATOR-CUSTOMIZED SKEPTIC\n');
        // The other 8 souls DID land (collision is per-file, not all-or-nothing).
        const conductorAfter = await fs.readFile(path.join(soulsDir, 'conductor.md'), 'utf8');
        expect(conductorAfter).toBe('cond\n');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('overwrite prompt', () => {
    it('overwrites the file when user selects "overwrite"', async () => {
      // Choice 1 = overwrite
      const io = makeIo(['1']);
      const writtenPaths: string[] = [];

      await runFinalize({
        state: makeFullState(),
        io,
        cwd: () => '/fake/cwd',
        fileExists: async () => true, // file exists
        writeEnvFile: async (p) => {
          writtenPaths.push(p);
        },
      });

      expect(writtenPaths).toEqual(['/fake/cwd/.env']);
    });

    it('writes to .env.new when user selects "write next to it"', async () => {
      // Choice 2 = write next to it as .env.new
      const io = makeIo(['2']);
      const writtenPaths: string[] = [];

      await runFinalize({
        state: makeFullState(),
        io,
        cwd: () => '/fake/cwd',
        fileExists: async () => true,
        writeEnvFile: async (p) => {
          writtenPaths.push(p);
        },
      });

      expect(writtenPaths).toEqual(['/fake/cwd/.env.new']);
    });

    it('does not write any file when user selects "abort"', async () => {
      // Choice 3 = abort
      const io = makeIo(['3']);
      const writtenPaths: string[] = [];

      await runFinalize({
        state: makeFullState(),
        io,
        cwd: () => '/fake/cwd',
        fileExists: async () => true,
        writeEnvFile: async (p) => {
          writtenPaths.push(p);
        },
      });

      expect(writtenPaths).toHaveLength(0);
      expect(io.output()).toContain('Aborted');
    });
  });

  describe('IncompleteStateError', () => {
    it('throws IncompleteStateError when coordinator is missing', async () => {
      const io = makeEofIo();

      await expect(
        runFinalize({
          state: makeIncompleteState(),
          io,
          fileExists: async () => false,
          writeEnvFile: async () => void 0,
        }),
      ).rejects.toThrow(IncompleteStateError);
    });

    it('lists all missing fields in the error', async () => {
      const io = makeEofIo();

      await expect(
        runFinalize({
          state: makeIncompleteState(),
          io,
          fileExists: async () => false,
          writeEnvFile: async () => void 0,
        }),
      ).rejects.toMatchObject({
        missingFields: expect.arrayContaining([
          'coordinator',
          'anthropic',
          ...BUILTIN_PERSONAS.map((p) => `personas.${p}`),
        ]),
      });
    });

    it('throws IncompleteStateError when anthropic is missing', async () => {
      const io = makeEofIo();
      const state = makeFullState({ anthropic: undefined });

      await expect(
        runFinalize({
          state,
          io,
          fileExists: async () => false,
          writeEnvFile: async () => void 0,
        }),
      ).rejects.toThrow(IncompleteStateError);
    });
  });
});

// ── runVerify tests ───────────────────────────────────────────────────────────

/** Build a complete rendered .env string for verify testing. */
function makeRenderedEnv(): string {
  const personaEntries = BUILTIN_PERSONAS.map((name, idx) => [
    name,
    {
      appId: String(1000 + idx + 1),
      installationId: String(2000 + idx + 1),
      privateKey: fakePem(name),
      githubUser: `test-${name}[bot]`,
    },
  ]);

  return renderEnv(
    WizardConfigSchema.parse({
      prefix: 'test-prefix',
      repo: { owner: 'alice', name: 'sandbox' },
      coordinator: {
        appId: '1000',
        installationId: '2000',
        privateKey: fakePem('coordinator'),
        githubUser: 'coord-bot',
      },
      personas: Object.fromEntries(personaEntries),
      anthropic: { kind: 'api_key', value: 'sk-ant-testkey' },
      tunables: { LOG_LEVEL: 'info' },
    }),
    { timestamp: '2026-01-01T00:00:00.000Z' },
  );
}

/** Create a stub Octokit that successfully returns for all App API calls. */
function makeSuccessOctokit(): Octokit {
  const octokit = {
    apps: {
      getAuthenticated: vi.fn().mockResolvedValue({ data: { id: 1000 } }),
      getInstallation: vi.fn().mockResolvedValue({ data: { id: 2000 } }),
    },
  } as unknown as Octokit;
  return octokit;
}

/** Create a stub Octokit that fails the GET /app auth call. */
function makeFailAuthOctokit(): Octokit {
  const octokit = {
    apps: {
      getAuthenticated: vi.fn().mockRejectedValue(new Error('401 Bad credentials')),
      getInstallation: vi.fn().mockRejectedValue(new Error('404 Not found')),
    },
  } as unknown as Octokit;
  return octokit;
}

/** Create a stub Octokit that authenticates but reports the installation as missing. */
function makeFailInstallOctokit(): Octokit {
  const octokit = {
    apps: {
      getAuthenticated: vi.fn().mockResolvedValue({ data: { id: 1000 } }),
      getInstallation: vi.fn().mockRejectedValue(new Error('404 Installation not found')),
    },
  } as unknown as Octokit;
  return octokit;
}

describe('runVerify', () => {
  describe('happy path — all checks pass', () => {
    it('returns exit code 0 when all structural checks and API calls succeed', async () => {
      const io = makeEofIo();
      const envContent = makeRenderedEnv();

      const exitCode = await runVerify({
        io,
        envPath: '/fake/.env',
        readEnvFile: async () => envContent,
        octokitFactory: () => makeSuccessOctokit(),
      });

      expect(exitCode).toBe(0);
      const out = io.output();
      expect(out).toContain('All checks passed');
    });

    it('outputs a checklist with ✔ for each passing check', async () => {
      const io = makeEofIo();
      const envContent = makeRenderedEnv();

      await runVerify({
        io,
        envPath: '/fake/.env',
        readEnvFile: async () => envContent,
        octokitFactory: () => makeSuccessOctokit(),
      });

      const out = io.output();
      // Coordinator structural checks
      expect(out).toContain('GITHUB_APP_ID');
      expect(out).toContain('GITHUB_APP_PRIVATE_KEY');
      expect(out).toContain('GITHUB_APP_INSTALLATION_ID');
      // Anthropic
      expect(out).toContain('ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('accepts CLAUDE_CODE_OAUTH_TOKEN as the Anthropic auth key', async () => {
      const io = makeEofIo();
      // Build a rendered .env with oauth token instead of API key
      const envContent = renderEnv(
        WizardConfigSchema.parse({
          prefix: 'test-prefix',
          repo: { owner: 'alice', name: 'sandbox' },
          coordinator: {
            appId: '1000',
            installationId: '2000',
            privateKey: fakePem('coordinator'),
            githubUser: 'coord-bot',
          },
          personas: Object.fromEntries(
            BUILTIN_PERSONAS.map((name, idx) => [
              name,
              {
                appId: String(1000 + idx + 1),
                installationId: String(2000 + idx + 1),
                privateKey: fakePem(name),
                githubUser: `test-${name}[bot]`,
              },
            ]),
          ),
          anthropic: { kind: 'oauth_token', value: 'claude-oauth-token-value-here' },
        }),
        { timestamp: '2026-01-01T00:00:00.000Z' },
      );

      const exitCode = await runVerify({
        io,
        envPath: '/fake/.env',
        readEnvFile: async () => envContent,
        octokitFactory: () => makeSuccessOctokit(),
      });

      expect(exitCode).toBe(0);
    });
  });

  describe('sad path — missing keys', () => {
    it('returns exit code 1 when coordinator keys are missing', async () => {
      const io = makeEofIo();
      // .env with no coordinator keys
      const envContent = '# empty\n';

      const exitCode = await runVerify({
        io,
        envPath: '/fake/.env',
        readEnvFile: async () => envContent,
        octokitFactory: () => makeSuccessOctokit(),
      });

      expect(exitCode).toBe(1);
      expect(io.output()).toContain('One or more checks failed');
    });

    it('reports which persona keys are missing', async () => {
      const io = makeEofIo();
      // Minimal .env that only has coordinator keys
      const envContent = [
        'GITHUB_APP_ID=1000',
        `GITHUB_APP_PRIVATE_KEY=${fakePem('coordinator').replace(/\n/g, '\\n')}`,
        'GITHUB_APP_INSTALLATION_ID=2000',
        'GITHUB_USER=coord-bot',
        'ANTHROPIC_API_KEY=sk-ant-test',
      ].join('\n');

      const exitCode = await runVerify({
        io,
        envPath: '/fake/.env',
        readEnvFile: async () => envContent,
        octokitFactory: () => makeSuccessOctokit(),
      });

      expect(exitCode).toBe(1);
      // Should mention missing persona keys
      const out = io.output();
      expect(out).toContain('ORCHESTRATOR_GITHUB_APP_ID');
    });

    it('returns exit code 1 when the .env file cannot be read', async () => {
      const io = makeEofIo();

      const exitCode = await runVerify({
        io,
        envPath: '/nonexistent/.env',
        readEnvFile: async () => {
          throw new Error('ENOENT: no such file or directory');
        },
        octokitFactory: () => makeSuccessOctokit(),
      });

      expect(exitCode).toBe(1);
      expect(io.output()).toContain('Cannot read');
    });
  });

  describe('PEM validation', () => {
    it('flags invalid PEM values (mismatched headers)', async () => {
      const io = makeEofIo();
      // Build a valid .env then corrupt one PEM
      const goodContent = makeRenderedEnv();
      // Replace the coordinator PEM with something broken
      const badContent = goodContent.replace(
        `'${fakePem('coordinator')}'`,
        "'-----BEGIN RSA PRIVATE KEY-----\\nBAD\\n-----END EC PRIVATE KEY-----'",
      );

      const exitCode = await runVerify({
        io,
        envPath: '/fake/.env',
        readEnvFile: async () => badContent,
        octokitFactory: () => makeSuccessOctokit(),
      });

      expect(exitCode).toBe(1);
      expect(io.output()).toContain('BEGIN/END header mismatch');
    });
  });

  describe('API checks', () => {
    it('flags App credentials failure and skips installation check', async () => {
      const io = makeEofIo();
      const envContent = makeRenderedEnv();

      const exitCode = await runVerify({
        io,
        envPath: '/fake/.env',
        readEnvFile: async () => envContent,
        octokitFactory: () => makeFailAuthOctokit(),
      });

      expect(exitCode).toBe(1);
      const out = io.output();
      expect(out).toContain('authentication failed');
    });

    it('flags installation failure when App auth succeeds but installation is missing', async () => {
      const io = makeEofIo();
      const envContent = makeRenderedEnv();

      const exitCode = await runVerify({
        io,
        envPath: '/fake/.env',
        readEnvFile: async () => envContent,
        octokitFactory: () => makeFailInstallOctokit(),
      });

      expect(exitCode).toBe(1);
      const out = io.output();
      expect(out).toContain('installation not found');
    });

    it('defaults envPath to cwd/.env when not specified', async () => {
      const io = makeEofIo();
      const readPaths: string[] = [];

      await runVerify({
        io,
        cwd: () => '/my/cwd',
        readEnvFile: async (p) => {
          readPaths.push(p);
          throw new Error('ENOENT');
        },
        octokitFactory: () => makeSuccessOctokit(),
      });

      expect(readPaths).toEqual(['/my/cwd/.env']);
    });
  });
});
