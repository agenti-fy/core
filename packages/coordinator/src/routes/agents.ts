import { z } from 'zod';
import {
  AgentRecordSchema,
  JobRecordSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  StatusSchema,
} from '@agentify/shared';
import type { ServerDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

export async function registerAgentRoutes(
  app: ZodFastify,
  deps: ServerDeps,
): Promise<void> {
  app.post(
    '/agents/register',
    {
      schema: {
        body: RegisterRequestSchema,
        response: { 200: RegisterResponseSchema },
      },
    },
    async (req) => {
      const agent = deps.store.registerAgent(req.body);
      deps.logger.info(
        { agent_id: agent.agent_id, name: agent.name, type: agent.type, url: agent.url },
        'agent registered',
      );
      return { agent_id: agent.agent_id };
    },
  );

  app.get(
    '/agents',
    { schema: { response: { 200: z.array(AgentRecordSchema) } } },
    async () => deps.store.listAgents(),
  );

  app.get(
    '/agents/:agent_id',
    {
      schema: {
        params: z.object({ agent_id: z.string().min(1) }),
        response: { 200: AgentRecordSchema },
      },
    },
    async (req, reply) => {
      const a = deps.store.getAgent(req.params.agent_id);
      if (!a) return reply.notFound(`agent ${req.params.agent_id} not registered`);
      return a;
    },
  );

  app.post(
    '/agents/:agent_id/heartbeat',
    {
      schema: {
        params: z.object({ agent_id: z.string().min(1) }),
        // Status is required: a healthy agent always knows its own state. A
        // null heartbeat would erase the dispatcher's "IDLE" view of a fresh
        // registration and effectively unregister the agent from routing.
        body: z.object({ status: StatusSchema }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      // Single SQL round-trip: recordHeartbeat returns false when no row
      // matched, which is the same signal as a missing agent. Saves the
      // separate `getAgent` lookup that previously gated this endpoint.
      // Heartbeats fire every 15s per agent — at scale this halves the
      // hot-loop query count.
      const ok = deps.store.recordHeartbeat(req.params.agent_id, req.body.status);
      if (!ok) return reply.notFound(`agent ${req.params.agent_id} not registered`);
      return { ok: true as const };
    },
  );

  app.get(
    '/agents/:agent_id/jobs',
    {
      schema: {
        params: z.object({ agent_id: z.string().min(1) }),
        querystring: z.object({
          limit: z.coerce.number().int().positive().max(500).default(50),
        }),
        response: { 200: z.array(JobRecordSchema) },
      },
    },
    async (req, reply) => {
      const a = deps.store.getAgent(req.params.agent_id);
      if (!a) return reply.notFound(`agent ${req.params.agent_id} not registered`);
      return deps.store.listJobsForAgent(req.params.agent_id, req.query.limit);
    },
  );

  app.delete(
    '/agents/:agent_id',
    {
      schema: {
        params: z.object({ agent_id: z.string().min(1) }),
        response: { 200: z.object({ deleted: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const ok = deps.store.deleteAgent(req.params.agent_id);
      if (!ok) return reply.notFound(`agent ${req.params.agent_id} not registered`);
      deps.logger.info({ agent_id: req.params.agent_id }, 'agent deleted');
      return { deleted: true };
    },
  );

  app.post(
    '/agents/:agent_id/reset',
    {
      schema: {
        params: z.object({ agent_id: z.string().min(1) }),
        response: {
          200: z.object({ ok: z.literal(true), agent_status: z.unknown() }),
          409: z.object({
            ok: z.literal(false),
            agent_status_code: z.literal(409),
            body: z.unknown(),
          }),
          503: z.object({
            ok: z.literal(false),
            agent_status_code: z.number().int(),
            body: z.unknown(),
          }),
        },
      },
    },
    async (req, reply) => {
      const a = deps.store.getAgent(req.params.agent_id);
      if (!a) return reply.notFound(`agent ${req.params.agent_id} not registered`);
      const result = await deps.agentClient.reset(a.url);
      if (result.statusCode === 409) {
        // Agent is BUSY — surface that distinctly so the TUI can show "wait
        // for current job" rather than a generic init failure.
        return reply.code(409).send({
          ok: false as const,
          agent_status_code: 409 as const,
          body: result.body,
        });
      }
      if (result.statusCode === 0) {
        // Transport failure (DNS / connection refused / timeout). The agent
        // is registered in our store but its container isn't reachable —
        // typically because docker compose stopped/removed it after the
        // record was created. Mark FAILURE so the dispatcher won't try to
        // route to a dead URL until the operator restarts the container
        // (which re-registers and clears FAILURE). Without this, the agent
        // sits IDLE in the store forever and dispatch keeps hitting ENOTFOUND.
        deps.store.recordHeartbeat(a.agent_id, 'FAILURE');
        deps.logger.warn(
          { agent_id: a.agent_id, url: a.url, body: result.body },
          'agent /reset unreachable — marked FAILURE',
        );
        return reply.code(503).send({
          ok: false as const,
          agent_status_code: 0,
          body: result.body,
        });
      }
      if (!result.ok) {
        return reply.code(503).send({
          ok: false as const,
          agent_status_code: result.statusCode,
          body: result.body,
        });
      }
      deps.store.recordHeartbeat(a.agent_id, 'IDLE');
      return { ok: true as const, agent_status: result.body };
    },
  );
}
