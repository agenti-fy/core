import { pino, type Logger } from 'pino';
import { LogBus, TeeStream } from '@agentify/shared';
import type { Config } from './config.js';

export interface LoggerWithBus {
  logger: Logger;
  bus: LogBus;
}

export function createLogger(
  config: Config,
  base: Record<string, unknown> = {},
): LoggerWithBus {
  const bus = new LogBus();
  const tee = new TeeStream(bus);
  const logger = pino(
    {
      level: config.logLevel,
      base: { service: 'agent', ...base },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    tee,
  );
  return { logger, bus };
}
