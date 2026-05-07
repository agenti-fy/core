import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'undici';
import {
  CallbackServer,
  CallbackStateMismatchError,
  CallbackTimeoutError,
  type CallbackServerHandle,
} from './callback-server.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeHtml(persona: string): string {
  return `<html><body>start page for ${persona}</body></html>`;
}

async function get(
  url: string,
): Promise<{ status: number; body: string }> {
  const res = await request(url);
  const body = await res.body.text();
  return { status: res.statusCode, body };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CallbackServer', () => {
  let handle: CallbackServerHandle;

  beforeEach(async () => {
    // Use a very short timeout so state-mismatch / close tests are fast.
    // We pass 5_000 ms as a safety net; most tests complete synchronously.
    handle = await CallbackServer.listen(5_000);
  });

  afterEach(async () => {
    // Always clean up — close() is idempotent after successful tests.
    try {
      await handle.close();
    } catch {
      // ignore: already closed in some tests
    }
  });

  // ── GET /start ─────────────────────────────────────────────────────────────

  describe('GET /start', () => {
    it('returns 404 when persona has not been staged', async () => {
      const { status, body } = await get(`${handle.baseUrl}/start?persona=tinkerer`);
      expect(status).toBe(404);
      expect(body).toContain('tinkerer');
    });

    it('returns 200 with staged HTML after stage() is called', async () => {
      const html = makeHtml('tinkerer');
      handle.stage('tinkerer', html, 'state-abc');
      const { status, body } = await get(`${handle.baseUrl}/start?persona=tinkerer`);
      expect(status).toBe(200);
      expect(body).toBe(html);
    });

    it('sets Cache-Control: no-store on the start page', async () => {
      handle.stage('orchestrator', makeHtml('orchestrator'), 'state-xyz');
      const res = await request(`${handle.baseUrl}/start?persona=orchestrator`);
      await res.body.text(); // drain
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('returns 404 for an unknown persona even when others are staged', async () => {
      handle.stage('orchestrator', makeHtml('orchestrator'), 'state-1');
      const { status } = await get(`${handle.baseUrl}/start?persona=unknown`);
      expect(status).toBe(404);
    });
  });

  // ── GET /callback – success path ───────────────────────────────────────────

  describe('GET /callback – success', () => {
    it('resolves awaitCallback with { code } and returns success page', async () => {
      handle.stage('tinkerer', makeHtml('tinkerer'), 'state-ok');
      const callbackPromise = handle.awaitCallback('state-ok');

      const { status, body } = await get(
        `${handle.baseUrl}/callback?code=gh-code-123&state=state-ok`,
      );

      expect(status).toBe(200);
      // Success page should tell the user to close the tab
      expect(body).toMatch(/close this tab/i);

      const result = await callbackPromise;
      expect(result).toEqual({ code: 'gh-code-123' });
    });

    it('resolves independently for two personas staged concurrently', async () => {
      handle.stage('tinkerer', makeHtml('tinkerer'), 'st-1');
      handle.stage('orchestrator', makeHtml('orchestrator'), 'st-2');
      const p1 = handle.awaitCallback('st-1');
      const p2 = handle.awaitCallback('st-2');

      await get(`${handle.baseUrl}/callback?code=code-A&state=st-1`);
      await get(`${handle.baseUrl}/callback?code=code-B&state=st-2`);

      expect(await p1).toEqual({ code: 'code-A' });
      expect(await p2).toEqual({ code: 'code-B' });
    });
  });

  // ── GET /callback – state mismatch ─────────────────────────────────────────

  describe('GET /callback – state mismatch', () => {
    it('returns 400 when state is not staged', async () => {
      const { status } = await get(
        `${handle.baseUrl}/callback?code=x&state=UNSTAGED`,
      );
      expect(status).toBe(400);
    });

    it('rejects all pending awaitCallback promises on unknown state arrival', async () => {
      handle.stage('tinkerer', makeHtml('tinkerer'), 'state-expected');
      const promise = handle.awaitCallback('state-expected');
      // Attach a noop handler immediately so Node.js does not flag the
      // rejection as unhandled before the assertion below can catch it.
      void promise.catch(() => {});

      // Send a callback with a completely different state.
      const { status } = await get(
        `${handle.baseUrl}/callback?code=stolen&state=WRONG-STATE`,
      );
      expect(status).toBe(400);

      await expect(promise).rejects.toBeInstanceOf(CallbackStateMismatchError);
    });

    it('includes the unexpected state in the rejection error', async () => {
      handle.stage('tinkerer', makeHtml('tinkerer'), 'state-ok');
      const promise = handle.awaitCallback('state-ok');
      void promise.catch(() => {}); // prevent unhandled-rejection before assertion

      await get(`${handle.baseUrl}/callback?code=x&state=INJECTED`);

      await expect(promise).rejects.toMatchObject({
        receivedState: 'INJECTED',
      });
    });

    it('returns 400 for a valid staged state when awaitCallback was not called', async () => {
      // Staged but no awaitCallback in flight.
      handle.stage('tinkerer', makeHtml('tinkerer'), 'state-staged');

      const { status } = await get(
        `${handle.baseUrl}/callback?code=x&state=state-staged`,
      );
      expect(status).toBe(400);
    });
  });

  // ── Timeout ────────────────────────────────────────────────────────────────

  describe('awaitCallback – timeout', () => {
    it('rejects with CallbackTimeoutError after the configured timeout', async () => {
      // Create a server with a very short timeout.
      const shortHandle = await CallbackServer.listen(10);
      try {
        shortHandle.stage('tinkerer', makeHtml('tinkerer'), 'state-t');
        const promise = shortHandle.awaitCallback('state-t');
        await expect(promise).rejects.toBeInstanceOf(CallbackTimeoutError);
      } finally {
        await shortHandle.close();
      }
    });
  });

  // ── close() ────────────────────────────────────────────────────────────────

  describe('close()', () => {
    it('closes the server — subsequent requests are refused', async () => {
      const url = handle.baseUrl;
      await handle.close();

      await expect(request(url)).rejects.toThrow();
    });

    it('rejects pending awaitCallback promises on close', async () => {
      handle.stage('tinkerer', makeHtml('tinkerer'), 'state-c');
      const promise = handle.awaitCallback('state-c');

      await handle.close();

      await expect(promise).rejects.toThrow('Server closed');
    });

    it('resolves cleanly when no callbacks are pending', async () => {
      await expect(handle.close()).resolves.toBeUndefined();
    });
  });

  // ── Unknown routes ─────────────────────────────────────────────────────────

  describe('unknown routes', () => {
    it('returns 404 for unregistered paths', async () => {
      const { status } = await get(`${handle.baseUrl}/unknown`);
      expect(status).toBe(404);
    });
  });
});
