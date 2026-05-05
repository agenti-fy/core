import type { LogBus, LogEntry } from './log-bus.js';

/**
 * Minimal Fastify-shaped surface we need to mount the SSE endpoint without
 * dragging Fastify into shared. Both agent and coordinator pass their
 * ZodFastify instance, which is structurally compatible.
 */
export interface SseFastifyLike {
  get(
    path: string,
    handler: (req: SseRequest, reply: SseReply) => Promise<unknown>,
  ): unknown;
}

export interface SseRequest {
  query?: unknown;
  raw: { on(event: string, listener: () => void): void };
}

export interface SseReply {
  /** Fastify v5: signals that the handler is taking over raw response writes,
   *  so post-handler hooks (logging, serialization) skip this reply. */
  hijack?: () => void;
  raw: {
    writeHead(status: number, headers: Record<string, string>): void;
    write(chunk: string): boolean;
    /** End the response — needed by the shutdown closer so http.Server.close
     *  can complete instead of waiting for SSE clients to disconnect. */
    end(): void;
    writableLength?: number;
    on(event: string, listener: () => void): void;
  };
}

const MAX_BUFFERED_BYTES = 1_000_000;
const HEARTBEAT_MS = 15_000;

export interface SseLogStreamOptions {
  /** How many recent entries to replay on connect when ?live=1 is NOT set. */
  recentReplay?: number;
}

/**
 * Mount `GET /logs/stream` on `app` as a long-lived Server-Sent Events
 * endpoint. Identical wire format on agent and coordinator: each `data:` line
 * is one JSON-encoded LogEntry; comment lines (`: heartbeat`) every 15s keep
 * idle clients alive. `?live=1` skips the recent-buffer replay (the
 * coordinator's LogForwarder uses live=1 to avoid duplicate fan-out on every
 * reconnect).
 */
export function registerSseLogStream(
  app: SseFastifyLike,
  bus: LogBus,
  opts: SseLogStreamOptions = {},
): void {
  const replaySize = opts.recentReplay ?? 50;
  app.get('/logs/stream', async (req, reply) => {
    // Take over the raw response so Fastify's post-handler logic doesn't try
    // to apply serialization/logging on a hijacked SSE stream.
    if (typeof reply.hijack === 'function') reply.hijack();
    const live = (req.query as { live?: string } | undefined)?.live === '1';
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let dropped = 0;
    let alive = true;

    const send = (entry: LogEntry): void => {
      if (!alive) return;
      // If the kernel send buffer or our internal write buffer is overfull,
      // skip rather than grow unbounded. The client will reconnect and
      // replay from the ring buffer.
      if ((reply.raw.writableLength ?? 0) > MAX_BUFFERED_BYTES) {
        dropped++;
        return;
      }
      try {
        reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch {
        alive = false;
      }
    };

    if (!live) {
      for (const entry of bus.recent(replaySize)) send(entry);
    }

    const onLog = (entry: LogEntry): void => send(entry);
    bus.on('log', onLog);

    const heartbeat = setInterval(() => {
      if (!alive) return;
      try {
        if (dropped > 0) {
          reply.raw.write(`: heartbeat (dropped=${dropped})\n\n`);
        } else {
          reply.raw.write(`: heartbeat\n\n`);
        }
      } catch {
        alive = false;
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();

    /**
     * Shutdown closer: ends our response so http.Server.close() can complete.
     * Without this, Node's server.close() waits indefinitely for the SSE
     * connection to be ended by the client, blocking graceful shutdown until
     * the watchdog force-exits.
     */
    const closeForShutdown = (): void => {
      if (!alive) return;
      alive = false;
      clearInterval(heartbeat);
      bus.off('log', onLog);
      try {
        reply.raw.write(`: server shutting down\n\n`);
        reply.raw.end();
      } catch {
        // socket may already be torn down — ignore
      }
    };
    const unregisterCloser = bus.registerSseCloser(closeForShutdown);

    const cleanup = (): void => {
      alive = false;
      clearInterval(heartbeat);
      bus.off('log', onLog);
      unregisterCloser();
    };

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    // Belt-and-suspenders: a hijacked response can be destroyed independently
    // of the request (e.g. write error during shutdown), and most SSE patterns
    // rely on req.close firing — but we shouldn't depend on that. Listening
    // here too means the bus listener can never outlive the connection.
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

    return reply;
  });
}
