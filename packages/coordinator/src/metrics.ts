import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import type { JobOutcome, Method } from '@agentify/shared';

/**
 * Coordinator metrics. Exposed at GET /metrics in Prometheus text format.
 *
 * We use a service-local Registry rather than the prom-client global, so that
 * tests and any future split into multiple coordinators don't leak counters
 * across boundaries.
 */
export class CoordinatorMetrics {
  readonly registry: Registry;
  readonly jobsTotal: Counter<'method' | 'outcome'>;
  readonly dispatchedTotal: Counter<'method' | 'kind'>;
  readonly dispatchLatency: Histogram<'method' | 'kind'>;
  readonly invalidRoutingLabelsTotal: Counter<'repo'>;
  readonly hijackAttemptsTotal: Counter<'repo' | 'pattern'>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry, prefix: 'agentify_coordinator_' });

    this.jobsTotal = new Counter({
      name: 'agentify_jobs_total',
      help: 'Total jobs by method and final outcome.',
      labelNames: ['method', 'outcome'],
      registers: [this.registry],
    });

    this.dispatchedTotal = new Counter({
      name: 'agentify_dispatched_total',
      help: 'Dispatch attempts grouped by method and outcome kind (accepted, busy, failure, method_not_supported, rejected, transport_error).',
      labelNames: ['method', 'kind'],
      registers: [this.registry],
    });

    this.dispatchLatency = new Histogram({
      name: 'agentify_dispatch_latency_ms',
      help: 'Coordinator → agent /<method> POST round-trip latency in ms.',
      labelNames: ['method', 'kind'],
      // Sub-100ms typical → 10s ceiling matches AgentRpcClient HTTP_TIMEOUT_MS;
      // anything beyond bodyTimeout fires as transport_error before this lands.
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000],
      registers: [this.registry],
    });

    this.invalidRoutingLabelsTotal = new Counter({
      name: 'agentify_coordinator_invalid_routing_labels_total',
      help: 'Labels starting with agent: that fail parseRoutingLabel validation (malformed persona or unknown method). Attack-signal counter.',
      labelNames: ['repo'],
      registers: [this.registry],
    });

    this.hijackAttemptsTotal = new Counter({
      name: 'agentify_coordinator_hijack_attempts_total',
      help: 'Issue bodies that triggered the hijack detector, counted per matched pattern name. Incremented once per unique body per pattern.',
      labelNames: ['repo', 'pattern'],
      registers: [this.registry],
    });
  }

  recordJobCompletion(method: Method, outcome: JobOutcome): void {
    this.jobsTotal.inc({ method, outcome });
  }

  recordDispatch(method: Method, kind: string, latencyMs: number): void {
    this.dispatchedTotal.inc({ method, kind });
    this.dispatchLatency.observe({ method, kind }, latencyMs);
  }

  recordInvalidRoutingLabel(repo: string): void {
    this.invalidRoutingLabelsTotal.inc({ repo });
  }

  recordHijackAttempt(repo: string, pattern: string): void {
    this.hijackAttemptsTotal.inc({ repo, pattern });
  }
}
