import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import type { JobOutcome, Method } from '@agentify/shared';

/** Scope for KB read/write operations. */
export type KbScope = 'global' | 'persona';

/** Outcome of a KB write attempt. */
export type KbWriteOutcome =
  | 'success'
  | 'conflict_retry_exhausted'
  | 'format_rejected'
  | 'wiki_disabled';

/**
 * Agent metrics. Exposed at GET /metrics in Prometheus text format. Wired
 * from the SkillRunner so we don't need access to running adapter internals.
 */
export class AgentMetrics {
  readonly registry: Registry;
  readonly jobsTotal: Counter<'method' | 'outcome'>;
  readonly jobDurationMs: Histogram<'method' | 'outcome'>;
  readonly tokensTotal: Counter<'kind'>;
  readonly costUsdTotal: Counter<'method'>;
  readonly kbReadsTotal: Counter<'scope'>;
  readonly kbWritesTotal: Counter<'scope' | 'outcome'>;
  readonly kbWriteConflictsTotal: Counter;

  constructor(persona: string) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ persona });
    collectDefaultMetrics({ register: this.registry, prefix: 'agentify_agent_' });

    this.jobsTotal = new Counter({
      name: 'agentify_jobs_total',
      help: 'Total skill runs by method and outcome.',
      labelNames: ['method', 'outcome'],
      registers: [this.registry],
    });

    this.jobDurationMs = new Histogram({
      name: 'agentify_job_duration_ms',
      help: 'Wall-clock skill duration in ms by method and outcome.',
      labelNames: ['method', 'outcome'],
      buckets: [
        100, 500, 1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
        600_000, 1_200_000,
      ],
      registers: [this.registry],
    });

    this.tokensTotal = new Counter({
      name: 'agentify_claude_tokens_total',
      help: 'Claude SDK tokens consumed, by kind (input, output, cache_read, cache_write).',
      labelNames: ['kind'],
      registers: [this.registry],
    });

    this.costUsdTotal = new Counter({
      name: 'agentify_claude_cost_usd_total',
      help: 'Cumulative Claude SDK cost in USD, by method.',
      labelNames: ['method'],
      registers: [this.registry],
    });

    this.kbReadsTotal = new Counter({
      name: 'agentify_kb_reads_total',
      help: 'Total knowledge-base reads, by scope (global|persona).',
      labelNames: ['scope'],
      registers: [this.registry],
    });

    this.kbWritesTotal = new Counter({
      name: 'agentify_kb_writes_total',
      help: 'Total knowledge-base write attempts, by scope and outcome.',
      labelNames: ['scope', 'outcome'],
      registers: [this.registry],
    });

    this.kbWriteConflictsTotal = new Counter({
      name: 'agentify_kb_write_conflicts_total',
      help: 'Total individual KB write conflict retries (every retry, regardless of final outcome).',
      registers: [this.registry],
    });
  }

  recordJob(method: Method, outcome: JobOutcome, durationMs: number): void {
    this.jobsTotal.inc({ method, outcome });
    this.jobDurationMs.observe({ method, outcome }, durationMs);
  }

  recordTokens(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    // Anthropic SDK usage fields are conventional; record what we recognize.
    const map: Record<string, string> = {
      input_tokens: 'input',
      output_tokens: 'output',
      cache_creation_input_tokens: 'cache_write',
      cache_read_input_tokens: 'cache_read',
    };
    for (const [src, kind] of Object.entries(map)) {
      const v = usage[src];
      if (typeof v === 'number' && v > 0) this.tokensTotal.inc({ kind }, v);
    }
  }

  recordCost(method: Method, costUsd: number | undefined): void {
    if (typeof costUsd !== 'number' || costUsd <= 0) return;
    this.costUsdTotal.inc({ method }, costUsd);
  }

  recordKbRead(scope: KbScope): void {
    this.kbReadsTotal.inc({ scope });
  }

  recordKbWrite(scope: KbScope, outcome: KbWriteOutcome): void {
    this.kbWritesTotal.inc({ scope, outcome });
  }

  recordKbWriteConflict(): void {
    this.kbWriteConflictsTotal.inc();
  }

  /**
   * Update the persona default-label after a SOUL hot-swap (POST /reset). The
   * registry is captured once at construction; without this hook, post-reset
   * scrapes would carry the stale persona name.
   */
  setPersona(persona: string): void {
    this.registry.setDefaultLabels({ persona });
  }
}
