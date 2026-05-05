import { z } from 'zod';
import type { ServerDeps } from '../server.js';
import type { ZodFastify } from '../types.js';

const HaltStateSchema = z.object({ halted: z.boolean() });

export async function registerControlRoutes(
  app: ZodFastify,
  deps: ServerDeps,
): Promise<void> {
  app.get(
    '/control/halt',
    { schema: { response: { 200: HaltStateSchema } } },
    async () => ({ halted: deps.store.isHalted() }),
  );

  // Canonical: PUT /control/halt with {halted: bool}.
  app.put(
    '/control/halt',
    { schema: { body: HaltStateSchema, response: { 200: HaltStateSchema } } },
    async (req) => {
      const wasHalted = deps.store.isHalted();
      deps.store.setHalted(req.body.halted);
      // Log only on transition so an operator slamming /halt repeatedly
      // doesn't see N "coordinator halted" warnings in the log.
      if (req.body.halted && !wasHalted) deps.logger.warn('coordinator halted');
      else if (!req.body.halted && wasHalted) deps.logger.info('coordinator resumed');
      return { halted: req.body.halted };
    },
  );

  // Aliases preserved for ergonomic curl + the TUI's existing keybindings.
  app.post(
    '/halt',
    { schema: { response: { 200: HaltStateSchema } } },
    async () => {
      const wasHalted = deps.store.isHalted();
      deps.store.setHalted(true);
      if (!wasHalted) deps.logger.warn('coordinator halted');
      return { halted: true };
    },
  );

  app.post(
    '/resume',
    { schema: { response: { 200: HaltStateSchema } } },
    async () => {
      const wasHalted = deps.store.isHalted();
      deps.store.setHalted(false);
      if (wasHalted) deps.logger.info('coordinator resumed');
      return { halted: false };
    },
  );
}
