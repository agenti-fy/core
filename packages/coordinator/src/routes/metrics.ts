import type { ServerDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

export async function registerMetricsRoutes(
  app: ZodFastify,
  deps: ServerDeps,
): Promise<void> {
  // Plain text/plain response — no zod schema (Prometheus format isn't JSON).
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });
}
