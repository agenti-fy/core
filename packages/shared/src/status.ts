import { z } from 'zod';

export const STATUSES = ['IDLE', 'BUSY', 'FAILURE'] as const;
export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

export const FailureCodeSchema = z.enum([
  'sdk_failure',
  'auth_failure',
  'config_failure',
]);
export type FailureCode = z.infer<typeof FailureCodeSchema>;

export const FailureInfoSchema = z.object({
  code: FailureCodeSchema,
  message: z.string(),
  ts: z.number().int(),
});
export type FailureInfo = z.infer<typeof FailureInfoSchema>;
