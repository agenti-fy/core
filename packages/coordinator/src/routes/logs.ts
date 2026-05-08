import { registerSseLogStream } from '@agenti-fy/shared';
import type { ServerDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

export function registerLogsRoutes(app: ZodFastify, deps: ServerDeps): void {
  registerSseLogStream(app, deps.logBus, { recentReplay: 100 });
}
