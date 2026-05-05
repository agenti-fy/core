import { z } from 'zod';
import { JobRecordSchema } from '@agentify/shared';
import type { ServerDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

export async function registerJobRoutes(
  app: ZodFastify,
  deps: ServerDeps,
): Promise<void> {
  app.get(
    '/jobs',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['open', 'recent', 'all']).default('open'),
          limit: z.coerce.number().int().positive().max(500).default(100),
        }),
        response: { 200: z.array(JobRecordSchema) },
      },
    },
    async (req) => {
      switch (req.query.status) {
        case 'open':
          return deps.store.listOpenJobs(req.query.limit);
        case 'recent':
          return deps.store.listRecentJobs(req.query.limit);
        case 'all': {
          // Open jobs first, then recent up to whatever is left of `limit`.
          // The combined response respects `limit` as a total cap so callers
          // get a predictable upper bound.
          const open = deps.store.listOpenJobs(req.query.limit);
          const remaining = Math.max(0, req.query.limit - open.length);
          const recent = remaining > 0 ? deps.store.listRecentJobs(remaining) : [];
          return [...open, ...recent];
        }
      }
    },
  );
}
