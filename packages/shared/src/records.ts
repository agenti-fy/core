import { z } from 'zod';
import { MethodSchema } from './methods.js';
import { PersonaTypeSchema } from './personas.js';
import { StatusSchema } from './status.js';
import { JobOutcomeSchema, RepoSchema } from './rpc.js';

/** Coordinator's view of a registered agent (mirrors the `agents` table). */
export const AgentRecordSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1),
  type: PersonaTypeSchema,
  version: z.string().min(1),
  url: z.string().url(),
  supported_methods: z.array(MethodSchema),
  registered_at: z.number().int(),
  last_heartbeat: z.number().int().nullable(),
  last_known_status: StatusSchema.nullable(),
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export const JobRecordStatusSchema = z.enum([
  'dispatched',
  'running',
  'complete',
  'failed',
  'failed_to_dispatch',
]);
export type JobRecordStatus = z.infer<typeof JobRecordStatusSchema>;

/** Coordinator's view of a job (mirrors the `jobs` table). */
export const JobRecordSchema = z.object({
  job_id: z.string().min(1),
  agent_id: z.string().min(1),
  method: MethodSchema,
  repo: RepoSchema,
  target_id: z.number().int().positive(),
  /** Routing-label persona segment — see DispatchRequest.persona_name.
   *  Defaults to '' for jobs migrated from the pre-persona schema. */
  persona_name: z.string(),
  status: JobRecordStatusSchema,
  outcome: JobOutcomeSchema.nullable(),
  dispatched_at: z.number().int(),
  completed_at: z.number().int().nullable(),
  result_json: z.string().nullable(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const RepoRecordSchema = z.object({
  repo: RepoSchema,
  poll_interval_s: z.number().int().positive(),
  active: z.boolean(),
  last_polled: z.number().int().nullable(),
});
export type RepoRecord = z.infer<typeof RepoRecordSchema>;
