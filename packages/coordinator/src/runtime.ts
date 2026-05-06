import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { CoordinatorStore } from './store.js';
import type { GitHubClient } from './github/client.js';
import { discoverRepos } from './github/discover.js';
import { pollDueRepos } from './poller/work-poller.js';
import { pollJobCompletions } from './poller/job-poller.js';
import { sweepStaleInProgress } from './poller/stale-sweeper.js';
import { monitorPullRequests } from './poller/pr-monitor.js';
import { scanPlansForCompletion } from './poller/plan-completion-poller.js';
import { dispatchBatch } from './dispatch/index.js';
import type { AgentRpcClient } from './agent-client.js';
import type { CoordinatorMetrics } from './metrics.js';

export interface RuntimeDeps {
  config: Config;
  store: CoordinatorStore;
  github: GitHubClient | null;
  agentClient: AgentRpcClient;
  logger: Logger;
  metrics?: CoordinatorMetrics;
}

export interface RuntimeHandles {
  stop: () => Promise<void>;
}

/** Hard cap per loop tick. If a tick takes longer, we re-arm anyway and let
 *  the hung promise resolve in the background. Without this, a single hung
 *  Octokit call (no built-in timeout) freezes the loop forever — observed
 *  in production where pr-monitor stopped firing after a flaky GitHub call.
 *  Generous (3min) so a slow-but-progressing scan isn't aborted needlessly. */
const LOOP_TICK_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Schedule a function to run on a fixed interval. Re-arms via setTimeout (not
 * setInterval) so a slow tick never overlaps itself. Returns an awaitable
 * stop function that waits for any in-flight tick to drain.
 */
function scheduleLoop(
  fn: () => Promise<void>,
  intervalMs: number,
  label: string,
  logger: Logger,
): () => Promise<void> {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // Promise.resolve().then(fn) converts a synchronous throw from fn into a
    // rejection. Without this, a sync throw escapes the try/finally entirely
    // and the loop dies silently.
    const work = Promise.resolve()
      .then(fn)
      .catch((err) => {
        logger.error(
          { loop: label, err: err instanceof Error ? err.message : String(err) },
          'loop tick failed',
        );
      });
    inFlight = work;

    // Race work against a watchdog timeout. If the timeout wins, we log and
    // re-arm anyway — the work continues in the background but cannot
    // permanently stall the loop.
    let timedOut = false;
    const watchdog = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timedOut = true;
        resolve();
      }, LOOP_TICK_TIMEOUT_MS);
      t.unref();
    });

    try {
      await Promise.race([work, watchdog]);
      if (timedOut) {
        logger.warn(
          { loop: label, timeoutMs: LOOP_TICK_TIMEOUT_MS },
          'loop tick exceeded watchdog — re-arming (hung work continues in background)',
        );
      }
    } finally {
      inFlight = null;
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
        timer.unref();
      }
    }
  };

  timer = setTimeout(() => void tick(), 0);
  timer.unref();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (inFlight) await inFlight.catch(() => undefined);
  };
}

/**
 * Spin up the coordinator's background loops.
 */
export function startRuntime(deps: RuntimeDeps): RuntimeHandles {
  const stops: Array<() => Promise<void>> = [];

  if (deps.github) {
    stops.push(
      scheduleLoop(
        () => discoverRepos(deps.github!, deps.store, deps.config, deps.logger),
        deps.config.installationRefreshSeconds * 1000,
        'discover-repos',
        deps.logger,
      ),
    );

    stops.push(
      scheduleLoop(
        async () => {
          const result = await pollDueRepos(deps.github!, deps.store, deps.logger, deps.metrics);

          // Halt detection: observed halt-agents label → halt. We do NOT
          // auto-clear on label removal — the work poller's `since=` filter can
          // skip a stale halt-bearing issue, which would silently resume
          // dispatch even though the operator's halt is still in place.
          // Operators clear via POST /resume or PUT /control/halt {halted:false}.
          if (result.haltSeen && !deps.store.isHalted()) {
            deps.store.setHalted(true);
            deps.logger.warn('halt-agents label seen — coordinator halted (POST /resume to clear)');
          }

          if (deps.store.isHalted()) {
            deps.logger.debug({ items: result.items.length }, 'halted; skipping dispatch');
            return;
          }

          const summary = await dispatchBatch(result.items, {
            store: deps.store,
            agentClient: deps.agentClient,
            logger: deps.logger,
            ...(deps.metrics ? { metrics: deps.metrics } : {}),
          });
          deps.logger.debug(
            { ...summary, scanned: result.scannedRepos, attempted: result.attemptedRepos },
            'work tick complete',
          );
        },
        // Tick faster than the per-repo cadence; the work poller filters to
        // repos actually due for polling. Default workPollSeconds (30s) is
        // typically the FLOOR for repo cadence; if you want sub-30s polling
        // for a specific repo, lower workPollSeconds too.
        Math.min(deps.config.workPollSeconds, deps.config.defaultPollIntervalSeconds) * 1000,
        'work-poller',
        deps.logger,
      ),
    );
    stops.push(
      scheduleLoop(
        async () => {
          const result = await sweepStaleInProgress(
            deps.github!,
            deps.store,
            deps.config.staleJobTimeoutSeconds * 1000,
            deps.logger,
          );
          if (result.swept > 0) {
            deps.logger.info(result, 'stale-sweep complete');
          } else {
            deps.logger.debug(result, 'stale-sweep complete (no sweeps)');
          }
        },
        deps.config.staleJobSweepSeconds * 1000,
        'stale-sweeper',
        deps.logger,
      ),
    );
    stops.push(
      scheduleLoop(
        async () => {
          const result = await monitorPullRequests(
            deps.github!,
            deps.store,
            {
              requiredReviewers: deps.config.prMonitorRequiredReviewers,
              maxReviewCycles: deps.config.prMaxReviewCycles,
            },
            deps.logger,
          );
          if (result.routed > 0) {
            deps.logger.info(result, 'pr-monitor tick');
          } else {
            deps.logger.debug(result, 'pr-monitor tick (no changes)');
          }
        },
        deps.config.prMonitorIntervalSeconds * 1000,
        'pr-monitor',
        deps.logger,
      ),
    );
    stops.push(
      scheduleLoop(
        async () => {
          const result = await scanPlansForCompletion(deps.github!, deps.store, deps.logger);
          if (result.closedParents > 0) {
            deps.logger.info(result, 'plan-completion-poller tick');
          } else {
            deps.logger.debug(result, 'plan-completion-poller tick (no closures)');
          }
        },
        deps.config.planCompletionPollSeconds * 1000,
        'plan-completion-poller',
        deps.logger,
      ),
    );
  } else {
    deps.logger.warn('GitHub disabled — repo discovery, work poller, and sweeper not started');
  }

  stops.push(
    scheduleLoop(
      () =>
        pollJobCompletions({
          store: deps.store,
          agentClient: deps.agentClient,
          logger: deps.logger,
          ...(deps.metrics ? { metrics: deps.metrics } : {}),
        }),
      deps.config.jobCompletionPollSeconds * 1000,
      'job-completion-poller',
      deps.logger,
    ),
  );

  // GC every hour. Not on the hot path.
  stops.push(
    scheduleLoop(
      async () => {
        const deleted = deps.store.gcJobs({
          failedDispatchOlderThanMs: deps.config.failedDispatchRetentionDays * 24 * 60 * 60 * 1000,
          completedOlderThanMs: deps.config.completedJobRetentionDays * 24 * 60 * 60 * 1000,
        });
        if (deleted > 0) deps.logger.info({ deleted }, 'jobs GC');
      },
      60 * 60 * 1000,
      'jobs-gc',
      deps.logger,
    ),
  );

  return {
    stop: async () => {
      await Promise.all(stops.map((s) => s()));
    },
  };
}
