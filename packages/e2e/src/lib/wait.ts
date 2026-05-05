export interface WaitResult<T> {
  ok: true;
  value: T;
  waited_ms: number;
}
export interface WaitTimeout {
  ok: false;
  reason: 'timeout';
  waited_ms: number;
}

export async function waitFor<T>(
  predicate: () => Promise<T | null | undefined>,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<WaitResult<T> | WaitTimeout> {
  const interval = opts.intervalMs ?? 3_000;
  const startedAt = Date.now();
   
  while (true) {
    const v = await predicate();
    if (v !== null && v !== undefined) {
      return { ok: true, value: v, waited_ms: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= opts.timeoutMs) {
      return { ok: false, reason: 'timeout', waited_ms: Date.now() - startedAt };
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}
