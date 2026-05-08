import { z } from 'zod';
import {
  DispatchAcceptedSchema,
  DispatchRequestSchema,
  FailureInfoSchema,
  METHODS,
  METHOD_PATHS,
  MethodSchema,
} from '@agenti-fy/shared';
import type { AgentDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

const BusyResponseSchema = z.object({
  error: z.literal('BUSY'),
  current_job_id: z.string().nullable(),
});

const FailureResponseSchema = z.object({
  error: z.literal('FAILURE'),
  last_failure: FailureInfoSchema.nullable(),
});

const MethodNotSupportedSchema = z.object({
  error: z.literal('METHOD_NOT_SUPPORTED'),
  method: MethodSchema,
});

const NotRegisteredSchema = z.object({
  error: z.literal('NOT_REGISTERED'),
});

const ShuttingDownSchema = z.object({
  error: z.literal('SHUTTING_DOWN'),
});

export async function registerMethodRoutes(
  app: ZodFastify,
  deps: AgentDeps,
): Promise<void> {
  for (const method of METHODS) {
    const path = `/${METHOD_PATHS[method]}`;
    app.post(
      path,
      {
        schema: {
          body: DispatchRequestSchema,
          response: {
            202: DispatchAcceptedSchema,
            405: MethodNotSupportedSchema,
            409: BusyResponseSchema,
            503: z.union([FailureResponseSchema, NotRegisteredSchema, ShuttingDownSchema]),
          },
        },
      },
      async (req, reply) => {
        // Refuse new work during shutdown drain — without this gate, a dispatch
        // can land between the runner.inFlight() check and app.close, leaving
        // a half-started run that the watchdog kills.
        if (deps.shutdown.get()) {
          return reply.code(503).send({ error: 'SHUTTING_DOWN' as const });
        }
        const status = deps.state.getStatus();
        if (status === 'BUSY') {
          return reply.code(409).send({
            error: 'BUSY' as const,
            current_job_id: deps.state.getCurrentJob()?.id ?? null,
          });
        }
        if (status === 'FAILURE') {
          return reply.code(503).send({
            error: 'FAILURE' as const,
            last_failure: deps.state.getLastFailure(),
          });
        }
        const supported = deps.soulRef.current.frontmatter.supported_methods;
        if (supported && !supported.includes(method)) {
          return reply.code(405).send({ error: 'METHOD_NOT_SUPPORTED' as const, method });
        }

        const job_id = req.body.job_id;
        const agent_id = deps.state.getAgentId();
        if (!agent_id) {
          return reply.code(503).send({ error: 'NOT_REGISTERED' as const });
        }

        const accepted = deps.state.startJob({
          id: job_id,
          method,
          repo: req.body.repo,
          target_id: req.body.id,
          started_at: Date.now(),
        });
        if (!accepted) {
          return reply.code(409).send({
            error: 'BUSY' as const,
            current_job_id: deps.state.getCurrentJob()?.id ?? null,
          });
        }

        deps.logger.info(
          { job_id, method, repo: req.body.repo, target_id: req.body.id },
          'job accepted',
        );

        deps.runner.enqueue({
          job_id,
          method,
          repo: req.body.repo,
          target_id: req.body.id,
          persona_name: req.body.persona_name,
          session_id: req.body.session_id,
        });

        return reply.code(202).send({
          job_id,
          agent_id,
          status: 'BUSY' as const,
        });
      },
    );
  }
}
