import { HealthResponseSchema, readPackageVersion } from '@agentify/shared';
import type { ServerDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

// dist/routes/health.js → ../.. → coordinator package root
const VERSION = readPackageVersion(import.meta.url, 2);

export async function registerHealthRoutes(
  app: ZodFastify,
  deps: ServerDeps,
): Promise<void> {
  app.get(
    '/health',
    { schema: { response: { 200: HealthResponseSchema } } },
    async () => ({
      ok: true as const,
      service: 'coordinator',
      version: VERSION,
      uptime_s: Math.floor((Date.now() - deps.startedAt) / 1000),
    }),
  );
}
