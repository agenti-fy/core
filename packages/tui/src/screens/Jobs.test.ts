import { describe, it, expect, vi, afterEach } from 'vitest';
import { JobResultSchema } from '@agentify/shared';
import type { JobRecord } from '@agentify/shared';
import { buildParsedResultCache } from './Jobs.js';

function makeJob(
  id: string,
  completedAt: number | null,
  resultJson: string | null = null,
): JobRecord {
  return {
    job_id: id,
    agent_id: 'agent-1',
    method: 'implement',
    repo: 'org/repo',
    target_id: 1,
    persona_name: 'tinkerer',
    status: completedAt !== null ? 'complete' : 'dispatched',
    outcome: completedAt !== null ? 'success' : null,
    dispatched_at: 1_000_000,
    completed_at: completedAt,
    result_json: resultJson,
  };
}

describe('buildParsedResultCache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses once and reuses the entry on repeated calls with the same (job_id, completed_at)', () => {
    const parseSpy = vi.spyOn(JobResultSchema, 'parse').mockReturnValue({} as never);

    const job = makeJob('j1', 12345, '{}');

    const cache1 = buildParsedResultCache([job], new Map());
    expect(parseSpy).toHaveBeenCalledTimes(1);

    const cache2 = buildParsedResultCache([job], cache1);
    expect(parseSpy).toHaveBeenCalledTimes(1); // no second parse

    // Same cache entry object reference is preserved
    expect(cache2.get('j1')).toBe(cache1.get('j1'));
  });

  it('evicts entries for jobs that leave the slice', () => {
    vi.spyOn(JobResultSchema, 'parse').mockReturnValue({} as never);

    const job1 = makeJob('j1', 11111, '{}');
    const job2 = makeJob('j2', 22222, '{}');

    const cache1 = buildParsedResultCache([job1, job2], new Map());
    expect(cache1.has('j1')).toBe(true);
    expect(cache1.has('j2')).toBe(true);

    // j2 drops out of the slice
    const cache2 = buildParsedResultCache([job1], cache1);
    expect(cache2.has('j1')).toBe(true);
    expect(cache2.has('j2')).toBe(false);
  });

  it('re-parses when completed_at changes', () => {
    const parseSpy = vi.spyOn(JobResultSchema, 'parse').mockReturnValue({} as never);

    const job = makeJob('j1', 11111, '{}');
    const cache1 = buildParsedResultCache([job], new Map());
    expect(parseSpy).toHaveBeenCalledTimes(1);

    const updatedJob = makeJob('j1', 99999, '{}');
    const cache2 = buildParsedResultCache([updatedJob], cache1);
    expect(parseSpy).toHaveBeenCalledTimes(2);
    expect(cache2.get('j1')?.completed_at).toBe(99999);
  });

  it('caches schema-validation failures (undefined) without re-parsing on the next tick', () => {
    const parseSpy = vi
      .spyOn(JobResultSchema, 'parse')
      .mockImplementation(() => { throw new Error('schema failure'); });

    // Provide valid JSON so JSON.parse succeeds, but schema parse throws
    const job = makeJob('j1', 12345, '{"bad":"payload"}');

    const cache1 = buildParsedResultCache([job], new Map());
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(cache1.get('j1')?.parsed).toBe(undefined);

    // Same completed_at → reuse the cached undefined; do not retry
    const cache2 = buildParsedResultCache([job], cache1);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(cache2.get('j1')?.parsed).toBe(undefined);
  });

  it('caches null result_json rows (pre-schema) without ever calling JobResultSchema.parse', () => {
    const parseSpy = vi.spyOn(JobResultSchema, 'parse');

    const job = makeJob('j1', 12345, null);

    const cache1 = buildParsedResultCache([job], new Map());
    expect(parseSpy).not.toHaveBeenCalled();
    expect(cache1.get('j1')?.parsed).toBe(undefined);

    const cache2 = buildParsedResultCache([job], cache1);
    expect(parseSpy).not.toHaveBeenCalled();
    expect(cache2.get('j1')?.parsed).toBe(undefined);
  });
});
