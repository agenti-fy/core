import { z } from 'zod';
import { RepoRecordSchema } from '@agentify/shared';
import type { ServerDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

export async function registerRepoRoutes(
  app: ZodFastify,
  deps: ServerDeps,
): Promise<void> {
  app.get(
    '/repos',
    { schema: { response: { 200: z.array(RepoRecordSchema) } } },
    async () => deps.store.listRepos(),
  );

  app.patch(
    '/repos/:owner/:name',
    {
      schema: {
        params: z.object({ owner: z.string().min(1), name: z.string().min(1) }),
        body: z.object({
          active: z.boolean().optional(),
          // Floor at 5s — sub-5s polling will quickly burn the GitHub
          // installation's secondary rate limit.
          poll_interval_s: z.number().int().min(5).optional(),
        }),
        response: { 200: RepoRecordSchema },
      },
    },
    async (req, reply) => {
      const repoStr = `${req.params.owner}/${req.params.name}`;
      const existing = deps.store.getRepo(repoStr);
      if (!existing) return reply.notFound(`repo ${repoStr} not managed`);
      const next = {
        repo: repoStr,
        poll_interval_s: req.body.poll_interval_s ?? existing.poll_interval_s,
        active: req.body.active ?? existing.active,
        last_polled: existing.last_polled,
      };
      deps.store.upsertRepo(next.repo, next.poll_interval_s, next.active);
      return next;
    },
  );
}
