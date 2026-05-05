import { request } from 'undici';
import type { LogEntry } from '@agentify/shared';

export type { LogEntry };

const RECONNECT_BASE_MS = 1500;
const MAX_PARTIAL_BYTES = 1_000_000;

/**
 * Connects to the coordinator's `/logs/stream` SSE endpoint and yields each
 * `data:` event as a parsed `LogEntry`. Reconnects on disconnect with at least
 * RECONNECT_BASE_MS between attempts. The caller signals stop via the
 * AbortController.
 *
 * First connect benefits from the coordinator's recent-buffer replay so the
 * Logs screen hydrates immediately. Subsequent reconnects pass `?live=1` to
 * SUPPRESS the replay — without that, every transient disconnect would re-push
 * the same 100 entries into the local ring buffer, producing duplicates that
 * scroll back as triplicates / quadruplicates over a long session.
 */
export async function* consumeLogs(
  baseUrl: string,
  abort: AbortController,
): AsyncGenerator<LogEntry, void, void> {
  let isFirstConnect = true;
  while (!abort.signal.aborted) {
    try {
      const url = isFirstConnect ? `${baseUrl}/logs/stream` : `${baseUrl}/logs/stream?live=1`;
      const res = await request(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: abort.signal,
      });
      if (res.statusCode !== 200) {
        await res.body.dump();
        await sleep(RECONNECT_BASE_MS, abort);
        continue;
      }
      let buf = '';
      res.body.setEncoding('utf8');
      for await (const chunk of res.body) {
        if (abort.signal.aborted) return;
        // Once we've received bytes from a connection, treat all future
        // reconnects as resumes — they should NOT re-fetch the recent buffer.
        // Doing this on first byte (rather than on response headers) makes the
        // logic robust to a connection that 200s and then EOFs immediately
        // without sending data: we'd retry with the original (replay-on)
        // semantics so the first successful connect still hydrates the UI.
        isFirstConnect = false;
        buf += chunk as string;
        // Drop instead of OOM if a peer never sends `\n\n`. Surface the drop
        // as a synthetic warn entry so the Logs screen shows SOMETHING rather
        // than the partial silently disappearing — stderr would scramble Ink.
        if (buf.length > MAX_PARTIAL_BYTES) {
          yield {
            ts: new Date().toISOString(),
            level: 40,
            service: 'tui',
            msg: `coordinator SSE partial buffer exceeded ${MAX_PARTIAL_BYTES} bytes — dropped`,
          };
          buf = '';
        }
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              yield JSON.parse(payload) as LogEntry;
            } catch {
              // skip
            }
          }
        }
      }
    } catch {
      if (abort.signal.aborted) return;
    }
    // Floor: at least RECONNECT_BASE_MS between connects, even on a clean EOF
    // with no error. Without this, a server that 200s then EOFs immediately
    // would let us hot-reconnect.
    if (!abort.signal.aborted) await sleep(RECONNECT_BASE_MS, abort);
  }
}

async function sleep(ms: number, abort: AbortController): Promise<void> {
  return new Promise((resolve) => {
    if (abort.signal.aborted) return resolve();
    // Without removeEventListener, every sleep() call leaks an abort listener
    // — over a long TUI session with intermittent network, listeners pile up.
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      abort.signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    t.unref();
    abort.signal.addEventListener('abort', onAbort, { once: true });
  });
}
