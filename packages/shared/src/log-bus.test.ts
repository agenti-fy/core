import { describe, it, expect, vi } from 'vitest';
import { LogBus, TeeStream, type LogEntry } from './log-bus.js';

function entry(level: number, msg: string): LogEntry {
  return { ts: new Date().toISOString(), level, msg };
}

describe('LogBus.publish', () => {
  it('delivers each entry to all listeners', () => {
    const bus = new LogBus(8);
    const a = vi.fn();
    const b = vi.fn();
    bus.on('log', a);
    bus.on('log', b);
    const e = entry(30, 'hello');
    bus.publish(e);
    expect(a).toHaveBeenCalledWith(e);
    expect(b).toHaveBeenCalledWith(e);
  });

  it('isolates listener exceptions so a buggy consumer does not break others', () => {
    const bus = new LogBus(8);
    const good = vi.fn();
    bus.on('log', () => {
      throw new Error('boom');
    });
    bus.on('log', good);
    const e = entry(40, 'still delivered');
    expect(() => bus.publish(e)).not.toThrow();
    expect(good).toHaveBeenCalledWith(e);
  });
});

describe('LogBus.recent', () => {
  it('returns the most recent N entries in chronological order', () => {
    const bus = new LogBus(5);
    for (let i = 0; i < 3; i++) bus.publish(entry(30, `msg-${i}`));
    const recent = bus.recent(10);
    expect(recent.map((e) => e.msg)).toEqual(['msg-0', 'msg-1', 'msg-2']);
  });

  it('returns at most `n` entries', () => {
    const bus = new LogBus(10);
    for (let i = 0; i < 5; i++) bus.publish(entry(30, `m${i}`));
    expect(bus.recent(2).map((e) => e.msg)).toEqual(['m3', 'm4']);
  });

  it('handles wrap-around correctly when capacity is exceeded', () => {
    const bus = new LogBus(3);
    bus.publish(entry(30, 'a'));
    bus.publish(entry(30, 'b'));
    bus.publish(entry(30, 'c'));
    bus.publish(entry(30, 'd')); // evicts 'a'
    bus.publish(entry(30, 'e')); // evicts 'b'
    const recent = bus.recent(10);
    expect(recent.map((e) => e.msg)).toEqual(['c', 'd', 'e']);
  });

  it('returns empty array when bus has never published', () => {
    const bus = new LogBus(8);
    expect(bus.recent()).toEqual([]);
  });
});

describe('LogBus SSE closer registry', () => {
  it('closeAllSse runs every registered closer', () => {
    const bus = new LogBus(8);
    const a = vi.fn();
    const b = vi.fn();
    bus.registerSseCloser(a);
    bus.registerSseCloser(b);
    bus.closeAllSse();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing closer so the rest still run', () => {
    const bus = new LogBus(8);
    const survivor = vi.fn();
    bus.registerSseCloser(() => {
      throw new Error('boom');
    });
    bus.registerSseCloser(survivor);
    expect(() => bus.closeAllSse()).not.toThrow();
    expect(survivor).toHaveBeenCalled();
  });

  it('unregister fn removes the closer so a self-disconnecting client is not called on shutdown', () => {
    const bus = new LogBus(8);
    const closer = vi.fn();
    const unregister = bus.registerSseCloser(closer);
    unregister();
    bus.closeAllSse();
    expect(closer).not.toHaveBeenCalled();
  });

  it('closeAllSse is idempotent — second call is a no-op', () => {
    const bus = new LogBus(8);
    const closer = vi.fn();
    bus.registerSseCloser(closer);
    bus.closeAllSse();
    bus.closeAllSse();
    expect(closer).toHaveBeenCalledTimes(1);
  });
});

describe('TeeStream', () => {
  it('publishes one bus entry per JSON line and ignores non-JSON', () => {
    const bus = new LogBus(8);
    const seen: LogEntry[] = [];
    bus.on('log', (e) => seen.push(e));
    // Suppress stdout for the test.
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true);
    try {
      const tee = new TeeStream(bus);
      tee.write('{"level":30,"time":"2024-01-01T00:00:00.000Z","msg":"first"}\n');
      tee.write('not-json\n');
      tee.write('{"level":40,"msg":"second"}\n');
    } finally {
      process.stdout.write = origWrite;
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]?.msg).toBe('first');
    expect(seen[0]?.level).toBe(30);
    expect(seen[1]?.msg).toBe('second');
    expect(seen[1]?.level).toBe(40);
  });

  it('reassembles JSON lines split across chunk boundaries', () => {
    const bus = new LogBus(8);
    const seen: LogEntry[] = [];
    bus.on('log', (e) => seen.push(e));
    const origWrite = process.stdout.write;
    process.stdout.write = (() => true);
    try {
      const tee = new TeeStream(bus);
      tee.write('{"level":30,"msg":"hel');
      tee.write('lo"}\n{"level":30,"msg":"world"}\n');
    } finally {
      process.stdout.write = origWrite;
    }
    expect(seen.map((e) => e.msg)).toEqual(['hello', 'world']);
  });
});
