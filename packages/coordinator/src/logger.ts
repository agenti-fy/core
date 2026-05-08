import { pino, type Logger } from 'pino';
import { LogBus, TeeStream } from '@agenti-fy/shared';
import type { Config } from './config.js';

export interface LoggerWithBus {
  logger: Logger;
  bus: LogBus;
}

export function createLogger(config: Config): LoggerWithBus {
  const bus = new LogBus();
  const tee = new TeeStream(bus);
  const logger = pino(
    {
      level: config.logLevel,
      base: { service: 'coordinator' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    tee,
  );
  return { logger, bus };
}
