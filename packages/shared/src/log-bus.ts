import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';

export interface LogEntry {
  ts: string;
  level: number;
  service?: string;
  msg?: string;
  agent_id?: string;
  job_id?: string;
  repo?: string;
  [key: string]: unknown;
}

/**
 * In-process pub/sub for structured log lines. Backed by a fixed-size circular
 * buffer (no Array.shift O(N) on push). Listener exceptions are isolated so
 * one bad consumer can't break log delivery.
 */
export class LogBus extends EventEmitter {
  private readonly ring: (LogEntry | undefined)[];
  private readonly capacity: number;
  private head = 0;
  private size = 0;
  /**
   * SSE-stream closers, keyed by the closer fn itself. Each /logs/stream
   * handler registers a closer on connect; the shutdown sequence calls
   * `closeAllSse()` to end all responses BEFORE `app.close()`. Without this,
   * Node's http.Server.close waits indefinitely for SSE connections to drain,
   * making graceful shutdown stall until the watchdog fires.
   */
  private readonly sseClosers = new Set<() => void>();

  constructor(capacity = 1000) {
    super();
    // Each /logs/stream subscriber adds one listener. 50 simultaneous SSE
    // consumers is more than enough headroom for production; if we ever blow
    // through it, the warning will surface a real leak (someone forgot to
    // .off() in their cleanup) rather than being silently swallowed.
    this.setMaxListeners(50);
    this.capacity = capacity;
    this.ring = new Array<LogEntry | undefined>(capacity);
  }

  /** Register a function to call during shutdown that ends one SSE response.
   *  Returns an unregister fn the SSE handler calls when its client
   *  disconnects of its own accord. */
  registerSseCloser(closer: () => void): () => void {
    this.sseClosers.add(closer);
    return () => this.sseClosers.delete(closer);
  }

  /** Synchronously call every registered SSE closer. Idempotent: registered
   *  closers are removed as they run, so the second call is a no-op. */
  closeAllSse(): void {
    for (const close of [...this.sseClosers]) {
      try {
        close();
      } catch {
        // isolation: a buggy closer must not break the shutdown sequence
      }
    }
    this.sseClosers.clear();
  }

  publish(entry: LogEntry): void {
    this.ring[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    // rawListeners is documented as not allocating per call when no
    // .once() listeners are present — cheaper than .listeners().
    const listeners = this.rawListeners('log') as ((entry: LogEntry) => void)[];
    for (const l of listeners) {
      try {
        l(entry);
      } catch {
        // isolation: a buggy listener must not break delivery to others
      }
    }
  }

  recent(n = 200): LogEntry[] {
    const want = Math.min(n, this.size);
    const out: LogEntry[] = new Array<LogEntry>(want);
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < want; i++) {
      const idx = (start + this.size - want + i) % this.capacity;
      out[i] = this.ring[idx]!;
    }
    return out;
  }
}

/** Hard cap on the partial-line buffer. A pino producer always sends `\n` per
 *  line; if something else writes garbage without newlines, we drop rather
 *  than grow indefinitely. */
const MAX_PARTIAL_BYTES = 1_000_000;

/**
 * Writable stream that JSON-parses each pino-emitted line, forwards it to the
 * LogBus, AND echoes the raw bytes to stdout. Uses an array buffer for the
 * trailing partial line to avoid O(N²) string concat.
 */
export class TeeStream extends Writable {
  private partial = '';

  constructor(private readonly bus: LogBus) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    process.stdout.write(text);
    let from = 0;
    let nl = text.indexOf('\n');
    while (nl !== -1) {
      const line = (this.partial ? this.partial + text.slice(from, nl) : text.slice(from, nl)).trim();
      this.partial = '';
      from = nl + 1;
      nl = text.indexOf('\n', from);
      if (line) this.publishLine(line);
    }
    if (from < text.length) {
      const tail = text.slice(from);
      if (this.partial.length + tail.length > MAX_PARTIAL_BYTES) {
        // Drop and warn: pino always terminates lines with \n, so a
        // megabyte+ partial means something pathological happened upstream.
        this.partial = '';
        this.bus.publish({
          ts: new Date().toISOString(),
          level: 40,
          msg: 'TeeStream: partial buffer exceeded cap — dropped',
        });
      } else {
        this.partial += tail;
      }
    }
    cb();
  }

  private publishLine(line: string): void {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const tsRaw = obj['time'];
      const ts =
        typeof tsRaw === 'string'
          ? tsRaw
          : typeof tsRaw === 'number'
            ? new Date(tsRaw).toISOString()
            : new Date().toISOString();
      const level = typeof obj['level'] === 'number' ? (obj['level']) : 30;
      this.bus.publish({ ...obj, ts, level });
    } catch {
      // not JSON — ignore (probably a non-pino write)
    }
  }
}
