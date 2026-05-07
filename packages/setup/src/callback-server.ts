/**
 * Local HTTP server that listens for the GitHub OAuth App Manifest callback.
 *
 * Binds to 127.0.0.1 on a random port so the endpoint is unreachable from
 * other hosts on the network.  The driver:
 *   1. Calls `stage(persona, html, state)` to pre-register the rendered start
 *      page and the expected `state` token for each persona.
 *   2. Calls `awaitCallback(state)` to receive the `code` once GitHub
 *      redirects back.
 *   3. Opens the browser to `<baseUrl>/start?persona=<name>`.
 *   4. Waits for the returned Promise to resolve with `{ code }`.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Public constants ─────────────────────────────────────────────────────────

/** Default callback timeout in milliseconds (10 minutes). */
export const CALLBACK_TIMEOUT_MS = 600_000;

// ── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when `awaitCallback` has not received a matching callback in time. */
export class CallbackTimeoutError extends Error {
  readonly state: string;
  constructor(state: string) {
    super(`OAuth callback timed out waiting for state "${state}"`);
    this.name = 'CallbackTimeoutError';
    this.state = state;
  }
}

/**
 * Thrown (and returned as a 400 response) when a `/callback` request arrives
 * carrying a `state` value that does not match any staged persona.  All
 * pending `awaitCallback` promises are rejected with this error.
 */
export class CallbackStateMismatchError extends Error {
  readonly receivedState: string;
  constructor(receivedState: string) {
    super(`OAuth callback carried an unexpected state value: "${receivedState}"`);
    this.name = 'CallbackStateMismatchError';
    this.receivedState = receivedState;
  }
}

// ── Internal types ───────────────────────────────────────────────────────────

interface StagedEntry {
  html: string;
  state: string;
}

interface PendingEntry {
  resolve: (result: { code: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Public handle returned by CallbackServer.listen() ────────────────────────

export interface CallbackServerHandle {
  /** The underlying Node.js HTTP server instance. */
  server: http.Server;

  /**
   * The base URL of the local server, e.g. `http://127.0.0.1:51234`.
   * Append `/start?persona=<name>` to open the auto-POST start page.
   */
  baseUrl: string;

  /**
   * Pre-register the rendered HTML page and the expected OAuth `state` token
   * for a persona.  Must be called before the browser is opened and before
   * `awaitCallback` is called for the same persona.
   */
  stage(persona: string, html: string, state: string): void;

  /**
   * Returns a Promise that resolves with `{ code }` when GitHub calls back
   * with the matching `state`.  Rejects with:
   * - `CallbackTimeoutError`       after `CALLBACK_TIMEOUT_MS`
   * - `CallbackStateMismatchError` if any callback arrives with an unknown
   *   state (possible CSRF / mis-wired redirect)
   */
  awaitCallback(state: string): Promise<{ code: string }>;

  /** Closes the server and rejects all pending callbacks. */
  close(): Promise<void>;
}

// ── Main class ───────────────────────────────────────────────────────────────

export class CallbackServer {
  /**
   * Starts the local HTTP server and returns a handle to interact with it.
   * The server binds to `127.0.0.1:0` (OS-assigned port).
   */
  static async listen(
    timeoutMs: number = CALLBACK_TIMEOUT_MS,
  ): Promise<CallbackServerHandle> {
    // persona → staged entry
    const staged = new Map<string, StagedEntry>();
    // state value → persona name (reverse index for O(1) look-up)
    const stateIndex = new Map<string, string>();
    // expected state → pending awaitCallback entry
    const pending = new Map<string, PendingEntry>();

    // ── Route handlers ─────────────────────────────────────────────────────

    function handleStart(
      searchParams: URLSearchParams,
      res: http.ServerResponse,
    ): void {
      const persona = searchParams.get('persona') ?? '';
      const entry = staged.get(persona);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Not found: persona "${persona}" has not been staged`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(entry.html);
    }

    function handleCallback(
      searchParams: URLSearchParams,
      res: http.ServerResponse,
    ): void {
      const code = searchParams.get('code') ?? '';
      const state = searchParams.get('state') ?? '';

      const personaName = stateIndex.get(state);

      if (!personaName) {
        // Unknown state — possible CSRF or misconfigured redirect.
        // Reject all pending callbacks so the driver can surface the error.
        const err = new CallbackStateMismatchError(state);
        for (const [, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(err);
        }
        pending.clear();
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderErrorPage(
            `State mismatch — received an unexpected state value. ` +
              `Please close this tab and restart the setup process.`,
          ),
        );
        return;
      }

      const pendingEntry = pending.get(state);
      if (!pendingEntry) {
        // State is valid but awaitCallback has not been called yet (or already
        // resolved).  Return 400 without touching any pending promises.
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderErrorPage(
            `No listener registered for this callback. ` +
              `The setup wizard may have already completed or timed out.`,
          ),
        );
        return;
      }

      // Happy path: state matches a staged persona and a pending awaiter.
      clearTimeout(pendingEntry.timer);
      pending.delete(state);
      pendingEntry.resolve({ code });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSuccessPage());
    }

    // ── Server ─────────────────────────────────────────────────────────────

    const server = http.createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/start') {
        handleStart(url.searchParams, res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/callback') {
        handleCallback(url.searchParams, res);
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
    const baseUrl = `http://127.0.0.1:${port}`;

    // ── Public handle methods ───────────────────────────────────────────────

    function stage(persona: string, html: string, state: string): void {
      staged.set(persona, { html, state });
      stateIndex.set(state, persona);
    }

    function awaitCallback(state: string): Promise<{ code: string }> {
      return new Promise<{ code: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(state);
          reject(new CallbackTimeoutError(state));
        }, timeoutMs);
        // Allow the process to exit even while waiting.
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(state, { resolve, reject, timer });
      });
    }

    function close(): Promise<void> {
      // Reject all outstanding awaitCallback promises.
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Server closed while waiting for OAuth callback'));
      }
      pending.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    return { server, baseUrl, stage, awaitCallback, close };
  }
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSuccessPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GitHub App created</title>
  <style>body{font-family:system-ui,sans-serif;max-width:480px;margin:4rem auto;text-align:center}</style>
</head>
<body>
  <h1>&#x2705; GitHub App created</h1>
  <p>The app has been registered successfully.</p>
  <p><strong>You can close this tab</strong> and return to the terminal.</p>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Setup error</title>
  <style>body{font-family:system-ui,sans-serif;max-width:480px;margin:4rem auto;text-align:center}</style>
</head>
<body>
  <h1>&#x274C; Setup error</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}
