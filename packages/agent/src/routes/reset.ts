import { z } from 'zod';
import { FailureInfoSchema, StatusSchema } from '@agenti-fy/shared';
import type { AgentDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

const ResetOkSchema = z.object({ status: StatusSchema });
const ResetBusySchema = z.object({
  error: z.literal('BUSY'),
  current_job_id: z.string().nullable(),
});
const ResetFailedSchema = z.object({
  error: z.literal('INIT_FAILED'),
  last_failure: FailureInfoSchema.nullable(),
});

export async function registerResetRoutes(
  app: ZodFastify,
  deps: AgentDeps,
): Promise<void> {
  app.post(
    '/reset',
    {
      schema: {
        response: {
          200: ResetOkSchema,
          409: ResetBusySchema,
          503: ResetFailedSchema,
        },
      },
    },
    async (_req, reply) => {
      // Refuse during BUSY: reinit() swaps soulRef and re-registers, but the
      // currently-running job has already resolved its prompts and adopted the
      // old persona's git identity. Mid-flight identity swap produces confusing
      // behavior (signature on failure comments uses new SOUL while git commits
      // use the old). Operator must wait for the job to complete or kill the
      // container.
      if (deps.state.getStatus() === 'BUSY') {
        return reply.code(409).send({
          error: 'BUSY' as const,
          current_job_id: deps.state.getCurrentJob()?.id ?? null,
        });
      }
      const ok = await deps.reinit();
      if (!ok) {
        return reply.code(503).send({
          error: 'INIT_FAILED' as const,
          last_failure: deps.state.getLastFailure(),
        });
      }
      return reply.code(200).send({ status: deps.state.getStatus() });
    },
  );
}
