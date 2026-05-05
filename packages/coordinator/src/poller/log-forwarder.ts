import { request } from 'undici';
import type { Logger } from 'pino';
import type { LogBus, LogEntry } from '@agentify/shared';
import type { CoordinatorStore } from '../store.js';

interface ForwarderDeps {
  store: CoordinatorStore;
  logBus: LogBus;
  logger: Logger;
}

interface Subscription {
  agent_id: string;
  url: string;
  abort: AbortController;
  task: Promise<void>;
}

const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const MAX_PARTIAL_BYTES = 1_000_000;

/**
 * Subscribes to each registered agent's `/logs/stream` SSE endpoint and
 * republishes events on the coordinator's LogBus. Reconnects with
 * exponential backoff (capped). Drops subscriptions for agents that have
 * disappeared from the agents table.
 */
export class LogForwarder {
  private subs = new Map<string, Subscription>();
  /**
   * Every consume() task we've ever started, until it settles. discover()
   * deletes from `subs` when an agent disappears, but the task keeps running
   * briefly until the abort signal unwinds it. Without this set, that orphan
   * task isn't awaited by stop().
   */
  private inFlightTasks = new Set<Promise<void>>();
  private stopped = false;
  private discoveryHandle: NodeJS.Timeout | null = null;
  /** In-flight guard: a slow discover() must not race with the next tick. */
  private discoverInFlight: Promise<void> | null = null;

  constructor(private readonly deps: ForwarderDeps) {}

  start(): void {
    void this.runDiscover();
    this.discoveryHandle = setInterval(() => void this.runDiscover(), 5000);
    this.discoveryHandle.unref();
  }

  private async runDiscover(): Promise<void> {
    if (this.discoverInFlight) return;
    this.discoverInFlight = this.discover().finally(() => {
      this.discoverInFlight = null;
    });
    await this.discoverInFlight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.discoveryHandle) clearInterval(this.discoveryHandle);
    if (this.discoverInFlight) await this.discoverInFlight.catch(() => undefined);
    for (const sub of this.subs.values()) sub.abort.abort();
    this.subs.clear();
    // Await every consume() we've ever launched — including ones whose subs
    // were already deleted by a discover() cycle but whose task is still
    // unwinding from the abort.
    await Promise.all([...this.inFlightTasks].map((t) => t.catch(() => undefined)));
  }

  private async discover(): Promise<void> {
    if (this.stopped) return;
    const agents = this.deps.store.listAgents();
    const seen = new Set(agents.map((a) => a.agent_id));

    for (const agent of agents) {
      const sub = this.subs.get(agent.agent_id);
      if (!sub) {
        this.connect(agent.agent_id, agent.url);
      } else if (sub.url !== agent.url) {
        sub.abort.abort();
        await sub.task.catch(() => undefined);
        this.subs.delete(agent.agent_id);
        this.connect(agent.agent_id, agent.url);
      }
    }
    for (const [id, sub] of this.subs) {
      if (!seen.has(id)) {
        sub.abort.abort();
        this.subs.delete(id);
        // The task is still in inFlightTasks; it'll remove itself once the
        // abort signal unwinds the consume loop.
      }
    }
  }

  private connect(agent_id: string, url: string): void {
    const abort = new AbortController();
    const task = this.consume(agent_id, url, abort).catch((err) => {
      this.deps.logger.debug(
        { agent_id, err: err instanceof Error ? err.message : String(err) },
        'log forwarder: stream ended',
      );
    });
    this.inFlightTasks.add(task);
    void task.finally(() => {
      this.inFlightTasks.delete(task);
    });
    this.subs.set(agent_id, { agent_id, url, abort, task });
  }

  private async consume(
    agent_id: string,
    url: string,
    abort: AbortController,
  ): Promise<void> {
    let attempt = 0;
    while (!this.stopped && !abort.signal.aborted) {
      let receivedBytes = false;
      try {
        // live=1 skips the agent's recent-buffer replay, so each reconnect
        // doesn't flood the coordinator bus with the last 50 duplicates.
        const res = await request(`${url}/logs/stream?live=1`, {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (res.statusCode !== 200) {
          await res.body.dump();
          attempt++;
          await sleep(backoff(attempt), abort);
          continue;
        }
        // Only reset the backoff once we actually saw bytes — otherwise an
        // agent that 200s + EOFs immediately would let us hot-reconnect.
        // One-shot guard so the assignment doesn't fire per-chunk.
        const onFirstByte = (): void => {
          if (receivedBytes) return;
          receivedBytes = true;
          attempt = 0;
        };
        await this.parseSse(agent_id, res.body, abort, onFirstByte);
      } catch (err) {
        if (abort.signal.aborted) return;
        this.deps.logger.debug(
          { agent_id, url, err: err instanceof Error ? err.message : String(err) },
          'log forwarder: connect error, retrying',
        );
      }
      if (!receivedBytes) attempt++;
      // Floor: at least RECONNECT_BASE_MS between attempts, even on success +
      // immediate clean EOF, so we never spin.
      await sleep(Math.max(RECONNECT_BASE_MS, backoff(attempt)), abort);
    }
  }

  private async parseSse(
    agent_id: string,
    body: NodeJS.ReadableStream,
    abort: AbortController,
    onBytes: () => void,
  ): Promise<void> {
    let buf = '';
    body.setEncoding('utf8');
    for await (const chunk of body) {
      if (abort.signal.aborted) return;
      onBytes();
      buf += chunk as string;
      // Hard cap on the partial-line buffer. A peer that never sends \n\n
      // would OOM us; drop and warn instead.
      if (buf.length > MAX_PARTIAL_BYTES) {
        this.deps.logger.warn(
          { agent_id, buffered: buf.length },
          'log forwarder: partial SSE buffer exceeded cap — dropping',
        );
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
            const entry = JSON.parse(payload) as LogEntry;
            const tagged: LogEntry = { ...entry, agent_id: entry.agent_id ?? agent_id };
            this.deps.logBus.publish(tagged);
          } catch {
            // skip
          }
        }
      }
    }
  }
}

function backoff(attempt: number): number {
  // Exponential with jitter, capped.
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6));
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

function sleep(ms: number, abort: AbortController): Promise<void> {
  return new Promise((resolve) => {
    if (abort.signal.aborted) return resolve();
    // We MUST removeEventListener (or use { once: true }) — without that, every
    // sleep() call leaves an abort listener attached to the same controller for
    // the lifetime of the consumer. After thousands of reconnects under churn,
    // we'd have thousands of dead closures retaining their setTimeout handles.
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
