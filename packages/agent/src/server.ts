import Fastify, { type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { AgentState } from './state.js';
import type { CoordinatorClient } from './coordinator-client.js';
import type { SkillRunner } from './runner/skill-runner.js';
import type { SoulRef } from './soul/ref.js';
import type { LogBus } from '@agentify/shared';
import type { AgentMetrics } from './metrics.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerJobsRoutes } from './routes/jobs.js';
import { registerMethodRoutes } from './routes/methods.js';
import { registerResetRoutes } from './routes/reset.js';
import { registerLogsRoutes } from './routes/logs.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import type { ZodFastify } from './types.js';

/**
 * Mutable shutdown flag shared with the methods routes. When set, /<method>
 * dispatches return 503 SHUTTING_DOWN immediately so a SIGTERM-triggered drain
 * doesn't race a fresh dispatch landing between inFlight() check and app.close.
 */
export class ShutdownFlag {
  private value = false;
  get(): boolean { return this.value; }
  set(): void { this.value = true; }
}

export interface AgentDeps {
  config: Config;
  soulRef: SoulRef;
  state: AgentState;
  coordinator: CoordinatorClient;
  runner: SkillRunner;
  logger: Logger;
  logBus: LogBus;
  metrics: AgentMetrics;
  startedAt: number;
  shutdown: ShutdownFlag;
  /** Re-runs init (validate env, reload SOUL, re-register). Returns whether init succeeded. */
  reinit: () => Promise<boolean>;
}

export async function buildAgentServer(deps: AgentDeps): Promise<ZodFastify> {
  const app = Fastify({
    // pino's Logger satisfies FastifyBaseLogger structurally; cast to match
    // Fastify v5's stricter typings (msgPrefix is added by Fastify at runtime).
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);

  await registerHealthRoutes(app, deps);
  await registerStatusRoutes(app, deps);
  await registerJobsRoutes(app, deps);
  await registerMethodRoutes(app, deps);
  await registerResetRoutes(app, deps);
  registerLogsRoutes(app, deps);
  await registerMetricsRoutes(app, deps);

  return app;
}
