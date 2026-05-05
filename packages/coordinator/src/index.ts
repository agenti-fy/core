import { join } from 'node:path';
import { reportConfigError } from '@agentify/shared';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { CoordinatorStore } from './store.js';
import { buildServer } from './server.js';
import { createGitHubClient } from './github/client.js';
import { checkHaltLabelAtStartup } from './github/halt-preflight.js';
import { AgentRpcClient } from './agent-client.js';
import { startRuntime } from './runtime.js';
import { LogForwarder } from './poller/log-forwarder.js';
import { CoordinatorMetrics } from './metrics.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { logger, bus: logBus } = createLogger(config);
  const store = new CoordinatorStore(join(config.dataDir, 'coordinator.db'));
  const startedAt = Date.now();

  // Crash-on-unhandled. Logging is best-effort; the orchestrator should
  // restart us. A "log and continue" policy can leave the process in a
  // corrupted state where subsequent operations silently misbehave.
  process.on('unhandledRejection', (reason) => {
    logger.fatal(
      {
        err: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
      'unhandledRejection — exiting',
    );
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException — exiting');
    process.exit(1);
  });

  const github = config.disableGithub ? null : createGitHubClient(config);
  const agentClient = new AgentRpcClient();
  const metrics = new CoordinatorMetrics();

  const app = await buildServer({
    config,
    store,
    agentClient,
    logger,
    logBus,
    metrics,
    startedAt,
  });

  // Listen first so by the time the runtime starts, /agents/register and
  // /sessions endpoints can serve booting agents.
  await app.listen({ host: config.host, port: config.port });
  logger.info(
    { host: config.host, port: config.port, github: github != null },
    'coordinator listening',
  );

  const runtime = startRuntime({ config, store, github, agentClient, logger, metrics });

  // Halt preflight: if the operator labeled an issue while we were down, the
  // work-poller's `since=` filter could miss it. Re-detect via GitHub search.
  // Fire-and-forget so a slow GitHub doesn't block boot — racing with dispatchBatch
  // is benign because setHalted(true) is sticky and the next dispatch tick observes it.
  // Bounded relevance: if the GitHub call took longer than this window, the
  // result is too stale to act on — by then the operator may have already
  // observed and resumed via /resume, and re-halting would undo their action.
  const PREFLIGHT_RELEVANCE_MS = 30_000;
  const preflightDeadline = Date.now() + PREFLIGHT_RELEVANCE_MS;
  if (github && !store.isHalted()) {
    void checkHaltLabelAtStartup(github, logger)
      .then((haltedNow) => {
        if (Date.now() > preflightDeadline) {
          logger.warn(
            'halt preflight returned after relevance window — ignoring stale result',
          );
          return;
        }
        if (haltedNow && !store.isHalted()) {
          store.setHalted(true);
          logger.warn(
            'halt-agents label observed at startup — coordinator halted (POST /resume to clear)',
          );
        }
      })
      .catch((err) => {
        // Don't let a setHalted/store error escalate to unhandledRejection
        // and crash the process. The check is best-effort.
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'halt preflight callback failed (non-fatal)',
        );
      });
  }

  const forwarder = new LogForwarder({ store, logBus, logger });
  forwarder.start();

  let closing = false;
  const SHUTDOWN_TIMEOUT_MS = 30_000;
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    // Watchdog — if graceful shutdown stalls, force-exit so the orchestrator
    // can restart us cleanly.
    const watchdog = setTimeout(() => {
      logger.fatal('shutdown watchdog fired — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    watchdog.unref();
    try {
      await forwarder.stop();
      await runtime.stop();
      // End all SSE streams BEFORE app.close — Node's http.Server.close keeps
      // existing connections and only resolves when ALL of them are ended.
      // Long-lived /logs/stream consumers (the TUI) would block close for the
      // full 30s watchdog window otherwise.
      logBus.closeAllSse();
      await app.close();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'shutdown error');
    } finally {
      clearTimeout(watchdog);
      store.close();
      process.exitCode = 0;
    }
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));
}

main().catch((err) => {
  if (!reportConfigError(err, 'coordinator')) {
     
    console.error('fatal:', err);
  }
  process.exit(1);
});
