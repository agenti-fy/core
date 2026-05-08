import { z } from 'zod';
import { JobResultSchema, MethodSchema, RepoSchema } from '@agenti-fy/shared';
import type { AgentDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

const JobDetailsSchema = z.object({
  job_id: z.string(),
  method: MethodSchema,
  repo: RepoSchema,
  target_id: z.number().int().positive(),
  started_at: z.number().int(),
  completed_at: z.number().int().nullable(),
  result: JobResultSchema.nullable(),
});

export async function registerJobsRoutes(
  app: ZodFastify,
  deps: AgentDeps,
): Promise<void> {
  app.get(
    '/jobs/:id',
    {
      schema: {
        params: z.object({ id: z.string().min(1) }),
        response: { 200: JobDetailsSchema },
      },
    },
    async (req, reply) => {
      const job = deps.state.getJob(req.params.id);
      if (!job) return reply.notFound(`job ${req.params.id} not found`);
      return job;
    },
  );
}
