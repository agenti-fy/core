import { registerSseLogStream } from '@agenti-fy/shared';
import type { AgentDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

export function registerLogsRoutes(app: ZodFastify, deps: AgentDeps): void {
  registerSseLogStream(app, deps.logBus, { recentReplay: 50 });
}
