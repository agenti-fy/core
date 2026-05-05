import type { AgentDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

export async function registerMetricsRoutes(
  app: ZodFastify,
  deps: AgentDeps,
): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });
}
