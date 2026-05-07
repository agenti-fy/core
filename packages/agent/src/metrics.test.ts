import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentMetrics,
  VALID_KB_WRITE_OUTCOMES,
  isKbWriteOutcome,
  assertKbWriteOutcome,
  type KbWriteOutcome,
} from './metrics.js';

describe('AgentMetrics', () => {
  let metrics: AgentMetrics;

  beforeEach(() => {
    metrics = new AgentMetrics('optimizer');
  });

  describe('registry contents', () => {
    it('lists agentify_kb_reads_total among registered metrics', async () => {
      const names = metrics.registry.getMetricsAsArray().map((m) => m.name);
      expect(names).toContain('agentify_kb_reads_total');
    });

    it('lists agentify_kb_writes_total among registered metrics', async () => {
      const names = metrics.registry.getMetricsAsArray().map((m) => m.name);
      expect(names).toContain('agentify_kb_writes_total');
    });

    it('lists agentify_kb_write_conflicts_total among registered metrics', async () => {
      const names = metrics.registry.getMetricsAsArray().map((m) => m.name);
      expect(names).toContain('agentify_kb_write_conflicts_total');
    });
  });

  describe('recordKbRead', () => {
    it('increments kbReadsTotal for global scope', async () => {
      metrics.recordKbRead('global');
      const values = await metrics.kbReadsTotal.get();
      const sample = values.values.find((v) => v.labels.scope === 'global');
      expect(sample?.value).toBe(1);
    });

    it('increments kbReadsTotal for persona scope', async () => {
      metrics.recordKbRead('persona');
      metrics.recordKbRead('persona');
      const values = await metrics.kbReadsTotal.get();
      const sample = values.values.find((v) => v.labels.scope === 'persona');
      expect(sample?.value).toBe(2);
    });
  });

  describe('recordKbWrite', () => {
    it('increments kbWritesTotal with scope and outcome', async () => {
      metrics.recordKbWrite('global', 'success');
      const values = await metrics.kbWritesTotal.get();
      const sample = values.values.find(
        (v) => v.labels.scope === 'global' && v.labels.outcome === 'success',
      );
      expect(sample?.value).toBe(1);
    });

    it('tracks conflict_retry_exhausted outcome', async () => {
      metrics.recordKbWrite('persona', 'conflict_retry_exhausted');
      const values = await metrics.kbWritesTotal.get();
      const sample = values.values.find(
        (v) => v.labels.scope === 'persona' && v.labels.outcome === 'conflict_retry_exhausted',
      );
      expect(sample?.value).toBe(1);
    });

    it('tracks wiki_disabled outcome', async () => {
      metrics.recordKbWrite('global', 'wiki_disabled');
      const values = await metrics.kbWritesTotal.get();
      const sample = values.values.find(
        (v) => v.labels.scope === 'global' && v.labels.outcome === 'wiki_disabled',
      );
      expect(sample?.value).toBe(1);
    });
  });

  describe('recordKbWriteConflict', () => {
    it('increments kbWriteConflictsTotal on each call', async () => {
      metrics.recordKbWriteConflict();
      metrics.recordKbWriteConflict();
      metrics.recordKbWriteConflict();
      const values = await metrics.kbWriteConflictsTotal.get();
      const total = values.values.reduce((sum, v) => sum + v.value, 0);
      expect(total).toBe(3);
    });
  });

  describe('isKbWriteOutcome', () => {
    it.each(['success', 'conflict_retry_exhausted', 'format_rejected', 'wiki_disabled'] as const)(
      'returns true for valid literal %s',
      (value) => {
        expect(isKbWriteOutcome(value)).toBe(true);
      },
    );

    it('returns false for empty string', () => {
      expect(isKbWriteOutcome('')).toBe(false);
    });

    it('returns false for wrong case (Success)', () => {
      expect(isKbWriteOutcome('Success')).toBe(false);
    });

    it('returns false for unknown literal', () => {
      expect(isKbWriteOutcome('unknown_outcome')).toBe(false);
    });

    it('returns false for null', () => {
      expect(isKbWriteOutcome(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isKbWriteOutcome(undefined)).toBe(false);
    });

    it('returns false for a number', () => {
      expect(isKbWriteOutcome(42)).toBe(false);
    });
  });

  describe('assertKbWriteOutcome', () => {
    it.each(['success', 'conflict_retry_exhausted', 'format_rejected', 'wiki_disabled'] as const)(
      'returns void for valid literal %s',
      (value) => {
        expect(() => assertKbWriteOutcome(value)).not.toThrow();
      },
    );

    it('throws Error with stringified value for empty string', () => {
      expect(() => assertKbWriteOutcome('')).toThrow(Error);
      expect(() => assertKbWriteOutcome('')).toThrow('""');
    });

    it('throws Error containing the offending value for unknown literal', () => {
      expect(() => assertKbWriteOutcome('bad_value')).toThrow('Invalid KbWriteOutcome');
      expect(() => assertKbWriteOutcome('bad_value')).toThrow('"bad_value"');
    });

    it('throws Error containing JSON.stringify output for null', () => {
      expect(() => assertKbWriteOutcome(null)).toThrow('null');
    });

    it('throws Error containing JSON.stringify output for undefined', () => {
      // JSON.stringify(undefined) === undefined, so message ends without a value
      expect(() => assertKbWriteOutcome(undefined)).toThrow('Invalid KbWriteOutcome');
    });

    it('throws Error containing JSON.stringify output for a number', () => {
      expect(() => assertKbWriteOutcome(99)).toThrow('99');
    });
  });

  describe('VALID_KB_WRITE_OUTCOMES keep-in-sync', () => {
    it('contains exactly the same members as the KbWriteOutcome union', () => {
      // This array's element type is checked against KbWriteOutcome at compile
      // time: adding a 5th union member without updating the array fails tsc.
      // Adding a 5th array element without updating the Set fails the size check.
      const ALL: readonly KbWriteOutcome[] = [
        'success',
        'conflict_retry_exhausted',
        'format_rejected',
        'wiki_disabled',
      ];
      expect(VALID_KB_WRITE_OUTCOMES.size).toBe(ALL.length);
      for (const v of ALL) {
        expect(VALID_KB_WRITE_OUTCOMES.has(v)).toBe(true);
      }
    });
  });

  describe('persona default-label inheritance', () => {
    it('KB counters carry the persona default label after setPersona', async () => {
      metrics.setPersona('skeptic');
      metrics.recordKbRead('global');
      const text = await metrics.registry.metrics();
      // The scrape output should contain the updated persona label on KB metrics
      expect(text).toContain('agentify_kb_reads_total');
      expect(metrics.registry.getMetricsAsArray().map((m) => m.name)).toContain(
        'agentify_kb_reads_total',
      );
      // Tightened assertion: the persona label must appear on the KB reads counter sample.
      // Uses [^}]* to tolerate arbitrary label ordering (prom-client order is not stable).
      expect(text).toMatch(/agentify_kb_reads_total\{[^}]*persona="skeptic"/);
    });

    it('agentify_kb_writes_total carries the persona default label after setPersona', async () => {
      metrics.setPersona('skeptic');
      metrics.recordKbWrite('global', 'success');
      const text = await metrics.registry.metrics();
      // Registry-membership guard: counter must exist in the registry.
      expect(text).toContain('agentify_kb_writes_total');
      expect(metrics.registry.getMetricsAsArray().map((m) => m.name)).toContain(
        'agentify_kb_writes_total',
      );
      // Tightened assertion: the persona label must appear on the KB writes counter sample.
      expect(text).toMatch(/agentify_kb_writes_total\{[^}]*persona="skeptic"/);
    });
  });
});
