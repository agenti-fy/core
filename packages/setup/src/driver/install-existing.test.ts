import { describe, it, expect, vi } from 'vitest';
import {
  appSlugFromGithubUser,
  parsePersonaCreds,
  runInstallExisting,
  EnvParseError,
} from './install-existing.js';
import type { IoStreams } from '../prompts.js';
import { InstallationTimeoutError } from '../install.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function captureIo(): IoStreams & { output(): string } {
  const chunks: string[] = [];
  return {
    stdin: process.stdin,
    stdout: {
      write(chunk: string | Buffer): boolean {
        chunks.push(String(chunk));
        return true;
      },
    } as IoStreams['stdout'],
    output(): string {
      return chunks.join('');
    },
  };
}

const PERSONAS = [
  'orchestrator', 'conductor', 'theorist', 'tinkerer', 'optimizer',
  'glue', 'skeptic', 'crafter', 'scribe',
] as const;

function envWithFullCredentials(): Record<string, string> {
  // Minimal but valid PEM-ish blob. The driver doesn't validate PEM shape;
  // anything non-empty here passes the parser. Real PEMs go through
  // @octokit/auth-app, which we mock at the octokitFactory boundary.
  const fakePem = '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----';
  const env: Record<string, string> = {
    GITHUB_APP_ID: '100',
    GITHUB_APP_INSTALLATION_ID: '200',
    GITHUB_APP_PRIVATE_KEY: fakePem,
    GITHUB_USER: 'agenti-fy-orchestrator[bot]',
  };
  for (let i = 0; i < PERSONAS.length; i++) {
    const p = PERSONAS[i]!;
    const upper = p.toUpperCase();
    env[`${upper}_GITHUB_APP_ID`] = String(1000 + i);
    env[`${upper}_GITHUB_APP_INSTALLATION_ID`] = String(2000 + i);
    env[`${upper}_GITHUB_APP_PRIVATE_KEY`] = fakePem;
    env[`${upper}_GITHUB_USER`] = `agenti-fy-${p}[bot]`;
  }
  return env;
}

// ── parsePersonaCreds ────────────────────────────────────────────────────────

describe('parsePersonaCreds', () => {
  it('extracts (appId, privateKey, installationId, githubUser) for every built-in persona', () => {
    const env = envWithFullCredentials();
    const out = parsePersonaCreds(env);
    expect(Object.keys(out).sort()).toEqual([...PERSONAS].sort());
    for (let i = 0; i < PERSONAS.length; i++) {
      const persona = PERSONAS[i]!;
      const creds = out[persona];
      expect(creds.appId).toBe(1000 + i);
      expect(creds.installationId).toBe(2000 + i);
      expect(creds.privateKey).toContain('BEGIN PRIVATE KEY');
      expect(creds.githubUser).toBe(`agenti-fy-${persona}[bot]`);
    }
  });

  it('throws EnvParseError listing every missing key (one shot, not iterative)', () => {
    const env = envWithFullCredentials();
    delete env['SKEPTIC_GITHUB_APP_PRIVATE_KEY'];
    delete env['CRAFTER_GITHUB_APP_INSTALLATION_ID'];

    let err: unknown;
    try {
      parsePersonaCreds(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvParseError);
    const e = err as EnvParseError;
    expect(e.missing).toContain('SKEPTIC_GITHUB_APP_PRIVATE_KEY');
    expect(e.missing).toContain('CRAFTER_GITHUB_APP_INSTALLATION_ID');
    // Crucially: does NOT list the legitimately-set keys.
    expect(e.missing).not.toContain('ORCHESTRATOR_GITHUB_APP_ID');
  });

  it('rejects non-positive integer App IDs', () => {
    const env = envWithFullCredentials();
    env['ORCHESTRATOR_GITHUB_APP_ID'] = 'not-a-number';
    expect(() => parsePersonaCreds(env)).toThrow(EnvParseError);
  });

  it('rejects non-positive integer installation IDs', () => {
    const env = envWithFullCredentials();
    env['CONDUCTOR_GITHUB_APP_INSTALLATION_ID'] = '0';
    expect(() => parsePersonaCreds(env)).toThrow(EnvParseError);
  });
});

// ── appSlugFromGithubUser ────────────────────────────────────────────────────

describe('appSlugFromGithubUser', () => {
  it('strips the trailing [bot] suffix from a bot login', () => {
    expect(appSlugFromGithubUser('agenti-fy-skeptic[bot]')).toBe('agenti-fy-skeptic');
  });

  it('returns the input unchanged when [bot] is not present', () => {
    expect(appSlugFromGithubUser('not-a-bot-login')).toBe('not-a-bot-login');
  });

  it('only strips the trailing [bot] (not internal [bot] occurrences)', () => {
    expect(appSlugFromGithubUser('weird-[bot]-name[bot]')).toBe('weird-[bot]-name');
  });
});

// ── runInstallExisting ───────────────────────────────────────────────────────

describe('runInstallExisting', () => {
  it('opens the configure URL for every persona and returns 0 on full success', async () => {
    const io = captureIo();
    const openedUrls: string[] = [];
    const polledRepos: string[] = [];

    const exitCode = await runInstallExisting({
      io,
      envPath: '/fake/.env',
      repo: { owner: 'new-org', name: 'new-repo' },
      readFile: async () => renderEnv(envWithFullCredentials()),
      // The driver wraps creds in an ExchangedApp shim and passes it to
      // octokitFactory + awaitFn. Verifying the URL stream + polling
      // invocation is enough — no real Octokit needed.
      octokitFactory: () => ({}) as never,
      openInBrowser: async (url) => {
        openedUrls.push(url);
      },
      awaitFn: async (_app, repo) => {
        polledRepos.push(`${repo.owner}/${repo.name}`);
        return { installationId: 99 };
      },
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(exitCode).toBe(0);
    // One URL per persona, all pointing at the installation settings page.
    expect(openedUrls).toHaveLength(9);
    for (const url of openedUrls) {
      expect(url).toMatch(/^https:\/\/github\.com\/settings\/installations\/\d+$/);
    }
    // Polling fires exactly once per persona for the new repo.
    expect(polledRepos).toHaveLength(9);
    for (const r of polledRepos) {
      expect(r).toBe('new-org/new-repo');
    }
    // Summary banner reports success.
    expect(io.output()).toMatch(/All 9 Apps now cover new-org\/new-repo/);
  });

  it('returns exit 1 when any persona times out, and names the failed personas', async () => {
    const io = captureIo();
    let pollIndex = 0;

    const exitCode = await runInstallExisting({
      io,
      envPath: '/fake/.env',
      repo: { owner: 'new-org', name: 'new-repo' },
      readFile: async () => renderEnv(envWithFullCredentials()),
      octokitFactory: () => ({}) as never,
      openInBrowser: async () => {},
      awaitFn: async () => {
        // Fail two of nine — alternating pattern picks specific personas.
        const i = pollIndex++;
        if (i === 4 || i === 7) {
          throw new InstallationTimeoutError('https://github.com/...');
        }
        return { installationId: 100 + i };
      },
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(exitCode).toBe(1);
    const out = io.output();
    // Fifth persona is `optimizer` (index 4 in BUILTIN_PERSONAS),
    // eighth is `crafter` (index 7).
    expect(out).toMatch(/2 of 9 Apps did NOT pick up the new repo: optimizer, crafter/);
  });

  it('returns exit 1 when .env cannot be read, with a clear error', async () => {
    const io = captureIo();
    const exitCode = await runInstallExisting({
      io,
      envPath: '/does/not/exist/.env',
      repo: { owner: 'new-org', name: 'new-repo' },
      readFile: async () => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      },
      octokitFactory: () => ({}) as never,
      openInBrowser: async () => {},
      awaitFn: async () => ({ installationId: 1 }),
    });
    expect(exitCode).toBe(1);
    expect(io.output()).toMatch(/Cannot read \/does\/not\/exist\/\.env: ENOENT/);
  });

  it('continues opening URLs even when the browser-open helper throws', async () => {
    const io = captureIo();
    const opened: string[] = [];

    const exitCode = await runInstallExisting({
      io,
      envPath: '/fake/.env',
      repo: { owner: 'new-org', name: 'new-repo' },
      readFile: async () => renderEnv(envWithFullCredentials()),
      octokitFactory: () => ({}) as never,
      openInBrowser: async (url) => {
        opened.push(url);
        // First call throws; subsequent calls succeed. Loop must not abort.
        if (opened.length === 1) {
          throw new Error('browser binary not found');
        }
      },
      awaitFn: async () => ({ installationId: 42 }),
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    // Despite the first openInBrowser throwing, every persona's URL was
    // attempted. No exit-1 from that — the failure path explicitly warns
    // and continues so the operator can still copy/paste the printed URLs.
    expect(opened).toHaveLength(9);
    expect(exitCode).toBe(0);
    expect(io.output()).toMatch(/Could not auto-open browser for orchestrator/);
  });

  it('passes the freshly-issued PEM to the octokitFactory (one factory call per persona)', async () => {
    const factoryCalls: Array<{ appId: number; pemHead: string }> = [];

    await runInstallExisting({
      io: captureIo(),
      envPath: '/fake/.env',
      repo: { owner: 'new-org', name: 'new-repo' },
      readFile: async () => renderEnv(envWithFullCredentials()),
      octokitFactory: (appId, privateKey) => {
        factoryCalls.push({ appId, pemHead: privateKey.slice(0, 30) });
        return ({}) as never;
      },
      openInBrowser: async () => {},
      awaitFn: async () => ({ installationId: 1 }),
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(factoryCalls).toHaveLength(9);
    for (const c of factoryCalls) {
      expect(c.appId).toBeGreaterThan(0);
      expect(c.pemHead).toContain('BEGIN PRIVATE KEY');
    }
    // Each App gets a unique appId — the .env-fixture assigns them sequentially.
    const ids = factoryCalls.map((c) => c.appId);
    expect(new Set(ids).size).toBe(9);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Render a Record<string,string> into dotenv format. The setup package's
 * `parseDotenv` round-trips with this — kept inline so the test file stays
 * self-contained.
 */
function renderEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => {
      // Quote multiline values so parseDotenv reassembles correctly.
      if (v.includes('\n')) {
        return `${k}="${v.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
      }
      return `${k}=${v}`;
    })
    .join('\n');
}
