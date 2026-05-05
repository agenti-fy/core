import Fastify, { type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { CoordinatorStore } from './store.js';
import type { AgentRpcClient } from './agent-client.js';
import type { LogBus } from '@agentify/shared';
import type { CoordinatorMetrics } from './metrics.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerRepoRoutes } from './routes/repos.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerControlRoutes } from './routes/control.js';
import { registerLogsRoutes } from './routes/logs.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import type { ZodFastify } from './types.js';

export interface ServerDeps {
  config: Config;
  store: CoordinatorStore;
  agentClient: AgentRpcClient;
  logger: Logger;
  logBus: LogBus;
  metrics: CoordinatorMetrics;
  startedAt: number;
}

export async function buildServer(deps: ServerDeps): Promise<ZodFastify> {
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
  await registerAgentRoutes(app, deps);
  await registerSessionRoutes(app, deps);
  await registerRepoRoutes(app, deps);
  await registerJobRoutes(app, deps);
  await registerControlRoutes(app, deps);
  registerLogsRoutes(app, deps);
  await registerMetricsRoutes(app, deps);

  return app;
}
