import { HealthResponseSchema, readPackageVersion } from '@agenti-fy/shared';
import type { AgentDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

// dist/routes/health.js → ../.. → agent package root
const VERSION = readPackageVersion(import.meta.url, 2);

export async function registerHealthRoutes(
  app: ZodFastify,
  deps: AgentDeps,
): Promise<void> {
  app.get(
    '/health',
    { schema: { response: { 200: HealthResponseSchema } } },
    async () => ({
      ok: true as const,
      service: `agent:${deps.soulRef.current.frontmatter.name}`,
      version: VERSION,
      uptime_s: Math.floor((Date.now() - deps.startedAt) / 1000),
    }),
  );
}
