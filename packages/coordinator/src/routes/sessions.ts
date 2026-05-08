import { z } from 'zod';
import { SessionPutSchema, SessionResponseSchema } from '@agenti-fy/shared';
import type { ServerDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

const ParamsSchema = z.object({
  agent_id: z.string().min(1),
  org: z.string().min(1),
  repo: z.string().min(1),
});

function repoString(p: { org: string; repo: string }): string {
  return `${p.org}/${p.repo}`;
}

export async function registerSessionRoutes(
  app: ZodFastify,
  deps: ServerDeps,
): Promise<void> {
  app.get(
    '/sessions/:agent_id/:org/:repo',
    {
      schema: {
        params: ParamsSchema,
        response: { 200: SessionResponseSchema },
      },
    },
    async (req, reply) => {
      const agent = deps.store.getAgent(req.params.agent_id);
      if (!agent) return reply.notFound(`agent ${req.params.agent_id} not registered`);
      const session_id = deps.store.getSession(req.params.agent_id, repoString(req.params));
      return { session_id };
    },
  );

  app.put(
    '/sessions/:agent_id/:org/:repo',
    {
      schema: {
        params: ParamsSchema,
        body: SessionPutSchema,
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      const agent = deps.store.getAgent(req.params.agent_id);
      if (!agent) return reply.notFound(`agent ${req.params.agent_id} not registered`);
      deps.store.upsertSession(
        req.params.agent_id,
        repoString(req.params),
        req.body.session_id,
      );
      return { ok: true as const };
    },
  );
}
