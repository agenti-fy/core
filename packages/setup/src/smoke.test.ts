/**
 * smoke.test.ts — mocked end-to-end smoke test for the setup wizard.
 *
 * Drives the full `run()` function against:
 *  - A fake in-process GitHub API server (manifest exchange + installations).
 *  - The real CallbackServer (the wizard's local OAuth callback server).
 *  - A stub `openInBrowser` that simulates the browser → GitHub → callback
 *    round-trip without opening a real browser.
 *  - Stubbed preamble and Anthropic phases (avoids real `gh` CLI and credentials).
 *  - A real `runApps` phase wired with the fake GitHub server via
 *    `Octokit({ baseUrl })` injection into `exchangeManifest` and
 *    `awaitInstallation`.
 *  - A real `runFinalize` phase that writes the `.env` to a tmp directory.
 *
 * The rendered `.env` is compared against the golden fixture at
 * `packages/setup/test/fixtures/expected.env` (timestamp line stripped).
 *
 * Design constraints:
 *  - All I/O is in-process — no real browser, real GitHub API, or real `gh` CLI.
 *  - Polling intervals are set to 0 so `awaitInstallation` returns immediately.
 *  - CallbackServer timeout is shortened to 10 s to keep CI failures fast.
 *  - Test timeout: 15 s (vitest per-test).
 */

import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import { Octokit } from '@octokit/rest';
import { run } from './index.js';
import { exchangeManifest } from './manifest-exchange.js';
import { awaitInstallation } from './install.js';
import { runApps as appsPhase } from './driver/apps.js';
import { CallbackServer } from './callback-server.js';
import { WIZARD_PERSONAS } from './personas.js';
import type { CliArgs } from './cli.js';
import type { IoStreams } from './prompts.js';
import type { PreambleResult } from './driver/preamble.js';
import type { ExchangedApp } from './manifest-exchange.js';
import type { RepoRef } from './install.js';

// ── Fixture constants ─────────────────────────────────────────────────────────

const PREFIX = 'testpfx';
const OWNER = 'alice';
const REPO_NAME = 'sandbox';
/** Fake Anthropic API key that passes the `sk-ant-` prefix check. */
const FAKE_ANTHROPIC_KEY = 'sk-ant-fakekey12345678901234567890';

/**
 * Deterministic fake PEM for persona at `idx`.
 *
 * Body = base64 of `fakepem-N` (9 bytes → 12 base64 chars, no padding):
 *   idx 0 → ZmFrZXBlbS0w
 *   idx 1 → ZmFrZXBlbS0x
 *   ...
 *   idx 8 → ZmFrZXBlbS04
 *
 * Passes the `isValidPem` validator (matching BEGIN/END headers) used by the
 * `runVerify` sub-command.
 */
function fakePem(idx: number): string {
  const lastChars = ['w', 'x', 'y', 'z', '0', '1', '2', '3', '4'] as const;
  const last = lastChars[idx];
  if (last === undefined) throw new Error(`fakePem: no fixture for idx ${idx}`);
  return (
    `-----BEGIN RSA PRIVATE KEY-----\nZmFrZXBlbS0${last}\n` +
    `-----END RSA PRIVATE KEY-----\n`
  );
}

// ── Fake GitHub API server ────────────────────────────────────────────────────

interface FakeGitHubServer {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Start an in-process fake GitHub API server that handles the two endpoints
 * the wizard exercises during a full `init` run:
 *
 *   POST /app-manifests/:code/conversions
 *     Returns a deterministic `ExchangedApp`-shaped payload (snake_case) based
 *     on call order.  The `code` parameter is ignored — the fake always returns
 *     data for the next persona in `WIZARD_PERSONAS` order.
 *
 *   GET /app/installations
 *     Returns a single installation whose `account.login` equals the target
 *     repo owner.  Call order determines the `id` so each persona receives a
 *     unique installation ID.
 *
 * Auth headers are ignored; the server returns 200/201 unconditionally for
 * matching routes so an unauthenticated `Octokit({ baseUrl })` works as the
 * injected client.
 */
async function startFakeGitHubServer(): Promise<FakeGitHubServer> {
  let manifestCallCount = 0;
  let installCallCount = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // POST /app-manifests/:code/conversions — manifest exchange endpoint.
    const manifestMatch = /^\/app-manifests\/([^/]+)\/conversions$/.exec(url.pathname);
    if (req.method === 'POST' && manifestMatch) {
      const idx = manifestCallCount++;
      const persona = WIZARD_PERSONAS[idx];
      if (!persona) {
        res.writeHead(422, { 'Content-Type': 'text/plain' });
        res.end(`No persona for idx ${idx}`);
        return;
      }

      const responseData = {
        id: 1000 + idx,
        slug: `${PREFIX}-${persona.name}`,
        name: `${PREFIX}-${persona.name}`,
        html_url: `https://github.com/apps/${PREFIX}-${persona.name}`,
        pem: fakePem(idx),
        client_id: `Iv1.mock${idx}`,
        client_secret: `secret${idx}`,
        webhook_secret: `hook${idx}`,
        owner: { login: OWNER, type: 'User', node_id: `MDQ6VXNlcjE=` },
        node_id: `MDM6QXBw${1000 + idx}`,
        external_url: `https://github.com/apps/${PREFIX}-${persona.name}`,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        description: null,
        installations_count: 0,
        events: [] as string[],
        permissions: {} as Record<string, string>,
      };

      // Consume the request body (required by the HTTP spec) before replying.
      req.resume();
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
      });
      return;
    }

    // GET /app/installations — list installations endpoint.
    if (req.method === 'GET' && url.pathname === '/app/installations') {
      const idx = installCallCount++;
      const responseData = [
        {
          id: 2000 + idx,
          account: {
            login: OWNER,
            type: 'User',
            node_id: 'MDQ6VXNlcjE=',
            avatar_url: '',
            html_url: `https://github.com/${OWNER}`,
          },
          app_id: 1000 + idx,
          target_type: 'User',
          html_url: `https://github.com/settings/installations/${2000 + idx}`,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseData));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ── Smoke test ────────────────────────────────────────────────────────────────

describe('smoke — full wizard end-to-end round-trip', () => {
  it(
    'renders .env matching the golden fixture',
    async () => {
      // 1. Start the fake GitHub API server and create an unauthenticated
      //    Octokit pointing at it.  The fake server ignores auth headers.
      const fakeGitHub = await startFakeGitHubServer();
      const testOctokit = new Octokit({ baseUrl: fakeGitHub.baseUrl });

      // 2. Tmp directory for the rendered .env (cleaned up in finally block).
      const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-smoke-'));

      try {
        // 3. I/O streams — all prompting phases are stubbed so stdin is never
        //    read.  stdout is captured to a PassThrough (output is not asserted
        //    here; we assert the .env file instead).
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        // Signal EOF so any accidental readline read resolves immediately
        // rather than hanging the test.
        stdin.end();
        const io: IoStreams = { stdin, stdout };

        // 4. Fake browser stub.
        //
        //    `openInBrowser` is called twice per persona in `runApps`:
        //      (a) with the wizard's local callback server URL
        //          `http://127.0.0.1:PORT/start?persona=<name>`
        //      (b) with the GitHub install URL
        //          `https://github.com/apps/<slug>/installations/new`
        //
        //    For (a) we simulate the full browser → GitHub → callback loop:
        //      1. GET the start page (which stages the HTML on the server).
        //      2. Extract the CSRF state nonce from the form's `action` URL.
        //      3. GET the callback URL with a synthetic code and the nonce.
        //
        //    The fetch calls are fired in a background IIFE so `openInBrowser`
        //    returns immediately, allowing `runApps` to proceed to the
        //    `server.awaitCallback(nonce)` call before the callback arrives.
        //    This matches the real-browser timing model.
        //
        //    For (b) we do nothing — the `awaitInstallation` poller handles it.
        const backgroundErrors: Error[] = [];

        const openInBrowser = async (url: string): Promise<void> => {
          if (!url.includes('/start?persona=')) {
            // Install URL — the awaitInstallation poller handles polling.
            return;
          }

          // Fire the browser simulation in the background so runApps can
          // proceed to awaitCallback() before the callback arrives.
          void (async () => {
            try {
              // Step 1: GET the start page to trigger staging and obtain the HTML.
              const startRes = await fetch(url);
              if (!startRes.ok) {
                throw new Error(
                  `Fake browser: GET ${url} returned ${startRes.status}`,
                );
              }
              const html = await startRes.text();

              // Step 2: Extract the state nonce from the form action URL.
              // The action looks like:
              //   https://github.com/settings/apps/new?state=<nonce>
              const stateMatch =
                /action="[^"]*\?(?:[^"&]*&)*state=([^"&]+)"/.exec(html);
              if (!stateMatch) {
                throw new Error(
                  `Fake browser: could not extract state nonce from start page HTML`,
                );
              }
              const nonce = decodeURIComponent(stateMatch[1]!);

              // Step 3: Build the callback URL and simulate GitHub's redirect.
              const startUrl = new URL(url);
              const callbackBase = `${startUrl.protocol}//${startUrl.host}`;
              const syntheticCode = `synthetic-code-${nonce.slice(0, 8)}`;
              const callbackUrl =
                `${callbackBase}/callback` +
                `?code=${encodeURIComponent(syntheticCode)}` +
                `&state=${encodeURIComponent(nonce)}`;

              const cbRes = await fetch(callbackUrl);
              if (!cbRes.ok) {
                throw new Error(
                  `Fake browser: GET ${callbackUrl} returned ${cbRes.status}`,
                );
              }
            } catch (err) {
              backgroundErrors.push(
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          })();
        };

        // 5. Injectable exchange and installation functions using the fake server.
        //    Both use the unauthenticated testOctokit pointed at fakeGitHub.
        const exchangeFn = (code: string): Promise<ExchangedApp> =>
          exchangeManifest(code, testOctokit);

        const awaitInstallFn = (
          app: ExchangedApp,
          repo: RepoRef,
        ): Promise<{ installationId: number }> =>
          awaitInstallation(
            app,
            repo,
            // intervalMs: 0 → no sleep between polls (fake server responds instantly).
            { intervalMs: 0, timeoutMs: 10_000 },
            testOctokit,
          );

        // 6. Preamble result — skips the real `gh auth status` / `gh repo view` calls.
        const PREAMBLE: PreambleResult = {
          prefix: PREFIX,
          repo: { owner: OWNER, name: REPO_NAME },
          ownerType: 'personal',
        };

        // 7. CLI args — point envOut at the tmp directory so runFinalize writes
        //    there instead of the current working directory.
        const cliArgs: CliArgs = {
          subcommand: 'init',
          prefix: undefined,
          repo: undefined,
          dryRun: false,
          envOut: path.join(tmpdir, '.env'),
          stateFile: undefined,
          // Smoke test runs in a tmp dir; suppress the compose+souls write
          // so it doesn't leave artifacts the rest of the test cares about.
          noCompose: true,
          imageTag: undefined,
          composeOut: undefined,
          showHelp: false,
          showVersion: false,
        };

        // 8. Run the full wizard.
        //
        //    Phases:
        //      • runPreamble   — stubbed (returns PREAMBLE directly)
        //      • runApps       — real implementation with injected I/O deps:
        //          - openInBrowser    → fake browser stub (see above)
        //          - exchangeManifest → real function via testOctokit → fakeGitHub
        //          - awaitInstallation→ real function via testOctokit → fakeGitHub
        //          - callbackServerFactory → real CallbackServer with 10-s timeout
        //          - saveState        → no-op (no checkpoint files needed in test)
        //      • runAnthropic   — stubbed (returns fixed credentials + tunables)
        //      • runFinalize    — real implementation (writes .env to tmpdir)
        //      • loadState      — no-op (always returns null — fresh run)
        //      • saveState      — no-op (global state writer; runApps has its own)
        const exitCode = await run(cliArgs, {
          io,

          // Inject a fixed passphrase so the smoke test never touches the
          // interactive masked-prompt loop (stdin is already ended above).
          passphraseProvider: async () => 'smoke-test-passphrase',

          runPreamble: async () => PREAMBLE,

          runApps: async ({ state, io: phaseIo }) =>
            appsPhase({
              state,
              io: phaseIo,
              // Same passphrase as passphraseProvider above — keeps checkpoints
              // encrypted consistently without a second prompt loop.
              passphrase: 'smoke-test-passphrase',
              openInBrowser,
              exchangeManifest: exchangeFn,
              awaitInstallation: awaitInstallFn,
              // Use a shorter-than-default callback timeout so CI fails fast
              // instead of hanging for 10 minutes if the fake browser breaks.
              callbackServerFactory: () => CallbackServer.listen(10_000),
              // No-op: we don't need per-persona checkpoint files in the smoke test.
              saveState: async () => { /* checkpoint no-op */ },
            }),

          runAnthropic: async () => ({
            anthropic: { kind: 'api_key' as const, value: FAKE_ANTHROPIC_KEY },
            tunables: {
              LOG_LEVEL: 'info',
              WORK_POLL_S: 30,
              CLAUDE_COST_LIMIT_USD: 5,
            },
          }),

          loadState: async () => null,
          saveState: async () => { /* global no-op */ },
        });

        // 9. Surface any errors from the fake browser background tasks.
        const firstError = backgroundErrors[0];
        if (firstError) throw firstError;

        // 10. Assert the wizard completed successfully.
        expect(exitCode).toBe(0);

        // 11. Read the rendered .env.
        const actualEnv = await fs.readFile(path.join(tmpdir, '.env'), 'utf8');

        // 12. Read the golden fixture.
        const fixtureUrl = new URL(
          '../test/fixtures/expected.env',
          import.meta.url,
        );
        const expectedEnv = await fs.readFile(
          fileURLToPath(fixtureUrl),
          'utf8',
        );

        // 13. Normalise timestamps before comparing.
        //     The generated header line contains the current ISO timestamp which
        //     changes every run.  Replace it with a stable placeholder so the
        //     golden comparison is deterministic.
        const normalise = (s: string): string =>
          s.replace(
            /^# Generated by agentify-setup at [^\n]+\n/,
            '# Generated by agentify-setup at <timestamp>\n',
          );

        expect(normalise(actualEnv)).toBe(normalise(expectedEnv));
      } finally {
        await fakeGitHub.close();
        await fs.rm(tmpdir, { recursive: true, force: true });
      }
    },
    15_000, // 15-second per-test timeout
  );
});
