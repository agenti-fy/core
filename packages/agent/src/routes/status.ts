import { AgentStatusResponseSchema } from '@agenti-fy/shared';
import type { AgentDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

export async function registerStatusRoutes(
  app: ZodFastify,
  deps: AgentDeps,
): Promise<void> {
  app.get(
    '/status',
    { schema: { response: { 200: AgentStatusResponseSchema } } },
    async () => ({
      status: deps.state.getStatus(),
      agent_id: deps.state.getAgentId(),
      current_job: deps.state.getCurrentJob(),
      last_failure: deps.state.getLastFailure(),
    }),
  );
}
