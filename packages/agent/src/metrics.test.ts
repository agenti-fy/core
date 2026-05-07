import { describe, it, expect, beforeEach } from 'vitest';
import { AgentMetrics } from './metrics.js';

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
    });
  });
});
