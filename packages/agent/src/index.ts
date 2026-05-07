import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import { METHODS, reportConfigError, type ParsedSoul } from '@agentify/shared';
import { loadConfig, resolveMaxTurns, applyHotReloadable, type Config } from './config.js';
import { createLogger } from './logger.js';
import { loadSoulFromFile } from './soul/parser.js';
import { SoulRef } from './soul/ref.js';
import { AgentState } from './state.js';
import { CoordinatorClient, CoordinatorHttpError } from './coordinator-client.js';
import { buildAgentServer, ShutdownFlag, type AgentDeps } from './server.js';
import { StubClaudeAdapter } from './claude/stub.js';
import { LiveClaudeAdapter } from './claude/live.js';
import type { ClaudeAdapter } from './claude/adapter.js';
import { SkillRunner } from './runner/skill-runner.js';
import { createGitHubAdapter } from './github/client.js';
import { WorktreeManager } from './git/worktree.js';
import { WikiManager } from './kb/wiki.js';
import { AgentMetrics } from './metrics.js';

function pickClaudeAdapter(config: Config, logger: Logger): ClaudeAdapter {
  const hasCredential = Boolean(config.anthropicApiKey || config.claudeCodeOAuthToken);
  const choice =
    config.claudeAdapter === 'auto'
      ? hasCredential
        ? 'live'
        : 'stub'
      : config.claudeAdapter;
  if (choice === 'live') {
    if (!hasCredential) {
      logger.warn(
        'CLAUDE_ADAPTER=live but neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set — SDK calls will likely 401',
      );
    }
    logger.info(
      { auth: config.anthropicApiKey ? 'api_key' : 'oauth_token' },
      'using LiveClaudeAdapter (@anthropic-ai/claude-agent-sdk)',
    );
    return new LiveClaudeAdapter({
      logger,
      maxTurnsForMethod: (method) => resolveMaxTurns(config, method),
      timeoutMsGetter: () => config.claudeTimeoutMs,
      costLimitUsd: config.claudeCostLimitUsd,
    });
  }
  logger.warn('using StubClaudeAdapter — no real Claude calls will be made');
  return new StubClaudeAdapter(logger);
}

async function registerWithRetry(
  client: CoordinatorClient,
  config: Config,
  soul: ParsedSoul,
  log: Logger,
): Promise<string> {
  const buildPayload = (): Parameters<CoordinatorClient['register']>[0] => ({
    name: soul.frontmatter.name,
    type: soul.frontmatter.type,
    version: soul.frontmatter.version,
    url: config.agentPublicUrl,
    supported_methods: soul.frontmatter.supported_methods ?? [...METHODS],
  });
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const id = await client.register(buildPayload());
      log.info({ attempt, agent_id: id }, 'registered with coordinator');
      return id;
    } catch (err) {
      log.warn(
        { attempt, err: err instanceof Error ? err.message : String(err) },
        'register attempt failed',
      );
      if (attempt >= config.registerMaxAttempts) {
        throw new Error(
          `failed to register with coordinator after ${attempt} attempts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await sleep(config.registerRetryMs);
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const initialSoul = loadSoulFromFile(config.soulPath);
  const { logger, bus: logBus } = createLogger(config, {
    soul: initialSoul.frontmatter.name,
    type: initialSoul.frontmatter.type,
  });

  // Crash-on-unhandled. See coordinator/src/index.ts for rationale.
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

  const state = new AgentState({ capacity: config.jobHistoryCapacity });
  const coordinator = new CoordinatorClient(config.coordinatorUrl, config.coordinatorTimeoutMs);

  // Mutable holder so the runner sees the latest SOUL after /reset without
  // depending on Object.assign or Proxy semantics.
  const soulRef = new SoulRef(initialSoul);

  const adapter = pickClaudeAdapter(config, logger);
  const github = createGitHubAdapter(config, logger);
  const worktreeManager = new WorktreeManager(config, soulRef, logger);
  // Share the token cache so both managers use a single GitHub App auth call
  // (DI from #251): one cached token serves both code-repo and wiki operations.
  const wikiManager = new WikiManager(config, soulRef, logger, worktreeManager.getTokenCache());
  const metrics = new AgentMetrics(initialSoul.frontmatter.name);
  const runner = new SkillRunner({
    config,
    soulRef,
    coordinator,
    adapter,
    github,
    worktreeManager,
    wikiManager,
    state,
    logger,
    metrics,
  });

  const reinit = async (): Promise<boolean> => {
    try {
      // Reload hot-reloadable config fields first so the next skill run picks
      // up new CLAUDE_MAX_TURNS_* values without a process restart.
      applyHotReloadable(config, loadConfig());
      const fresh = loadSoulFromFile(config.soulPath);
      soulRef.set(fresh);
      // Update the metrics persona label so post-reset scrapes carry the
      // current SOUL's name, not the boot-time one.
      metrics.setPersona(fresh.frontmatter.name);
      const id = await coordinator.register({
        name: fresh.frontmatter.name,
        type: fresh.frontmatter.type,
        version: fresh.frontmatter.version,
        url: config.agentPublicUrl,
        supported_methods: fresh.frontmatter.supported_methods ?? [...METHODS],
      });
      state.setAgentId(id);
      state.clearFailure();
      logger.info({ agent_id: id }, 'reinit succeeded');
      return true;
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'reinit failed');
      state.setFailure({
        code: 'config_failure',
        message: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      });
      return false;
    }
  };

  const startedAt = Date.now();
  const shutdown = new ShutdownFlag();
  const deps: AgentDeps = {
    config,
    soulRef,
    state,
    coordinator,
    runner,
    logger,
    logBus,
    metrics,
    startedAt,
    shutdown,
    reinit,
  };
  const app = await buildAgentServer(deps);

  // Listen FIRST so /status, /jobs/:id, /<method> are reachable the moment
  // we hand the coordinator our URL.
  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, 'agent listening');

  let agentId = await registerWithRetry(coordinator, config, soulRef.current, logger);
  state.setAgentId(agentId);

  // Self-healing re-register on heartbeat 404. Without this, an operator
  // running `DELETE /agents/<id>` (or a coordinator DB wipe / fresh-volume
  // restart) leaves the agent alive but invisible — its heartbeat 404s
  // forever and dispatch never reaches it.
  let reregisterInFlight: Promise<void> | null = null;
  const reregisterAfter404 = async (): Promise<void> => {
    try {
      const fresh = soulRef.current;
      const id = await coordinator.register({
        name: fresh.frontmatter.name,
        type: fresh.frontmatter.type,
        version: fresh.frontmatter.version,
        url: config.agentPublicUrl,
        supported_methods: fresh.frontmatter.supported_methods ?? [...METHODS],
      });
      agentId = id;
      state.setAgentId(id);
      logger.warn({ agent_id: id }, 're-registered after heartbeat 404');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        're-register attempt failed (will retry on next heartbeat)',
      );
    }
  };

  // Serialize heartbeats: skip a tick if the previous heartbeat is still in
  // flight. Without this guard, a coordinator slow enough to push a heartbeat
  // past `heartbeatIntervalMs` causes setInterval to stack concurrent calls,
  // wasting requests and amplifying load on an already-struggling coordinator.
  let heartbeatInFlight = false;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void coordinator
      .heartbeat(agentId, state.getStatus())
      .catch((err) => {
        if (err instanceof CoordinatorHttpError && err.statusCode === 404) {
          // Coalesce re-register attempts: if one is in flight, wait for it
          // instead of stacking parallel registrations.
          if (!reregisterInFlight) {
            reregisterInFlight = reregisterAfter404().finally(() => {
              reregisterInFlight = null;
            });
          }
          return;
        }
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'heartbeat failed',
        );
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, config.heartbeatIntervalMs);
  heartbeat.unref();

  let closing = false;
  const SHUTDOWN_TIMEOUT_MS = 30_000;
  // Reserve a couple of seconds for app.close() + final cleanup before the
  // watchdog fires. Both drain phases share this single deadline so total
  // shutdown stays bounded by SHUTDOWN_TIMEOUT_MS regardless of how many
  // drainOnce calls happen.
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    // Mark the shutdown flag FIRST so /<method> dispatches that arrive during
    // drain return 503 instead of starting a fresh run we can't drain.
    shutdown.set();
    logger.info({ signal }, 'shutting down');
    clearInterval(heartbeat);
    const startedAtClose = Date.now();
    const watchdog = setTimeout(() => {
      logger.fatal('shutdown watchdog fired — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    watchdog.unref();
    const deadline = startedAtClose + SHUTDOWN_TIMEOUT_MS - 2_000;
    const drainOnce = async (label: string): Promise<void> => {
      const inFlight = runner.inFlight();
      if (!inFlight) return;
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs === 0) {
        logger.warn({ phase: label }, 'drain budget exhausted — proceeding');
        return;
      }
      logger.info({ phase: label, remainingMs }, 'draining in-flight job');
      await Promise.race([
        inFlight,
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            logger.warn({ phase: label }, 'drain timeout — proceeding');
            resolve();
          }, remainingMs);
          t.unref();
        }),
      ]);
    };
    try {
      // Drain in-flight skill run, then app.close, then re-check inFlight in
      // case a setImmediate scheduled by a dispatch that landed *just* before
      // shutdown.set() fired during app.close's HTTP drain.
      await drainOnce('pre-close');
      // End all SSE streams BEFORE app.close — Node's http.Server.close keeps
      // existing connections and only resolves when ALL of them are ended.
      // Long-lived /logs/stream consumers would block close for the full
      // 30s watchdog window otherwise (exit code 1, every restart).
      logBus.closeAllSse();
      await app.close();
      await drainOnce('post-close');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'shutdown error',
      );
    } finally {
      clearTimeout(watchdog);
      process.exitCode = 0;
    }
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));
}

main().catch((err) => {
  if (!reportConfigError(err, 'agent')) {
     
    console.error('fatal:', err);
  }
  process.exit(1);
});
