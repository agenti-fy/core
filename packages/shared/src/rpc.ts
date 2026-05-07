import { z } from 'zod';
import { MethodSchema } from './methods.js';
import { PersonaNameSchema, PersonaTypeSchema } from './personas.js';
import { StatusSchema, FailureInfoSchema } from './status.js';

/* ========================================================================== */
/*                          Coordinator ↔ Agent contract                       */
/* ========================================================================== */

/**
 * GitHub repo string in the form `<owner>/<repo>`. GitHub owners are 1–39 chars,
 * alphanumeric + hyphens, no leading/trailing hyphen. Repo names allow dots,
 * underscores, and hyphens. Consecutive dots and `.git` suffix are forbidden.
 */
export const RepoSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/,
    'Repo must be "<owner>/<repo>"',
  )
  .refine((s) => !s.includes('..') && !s.endsWith('.git'), 'Bad repo characters');
export type Repo = z.infer<typeof RepoSchema>;

/* -------- Register -------- */

export const RegisterRequestSchema = z.object({
  name: PersonaNameSchema,
  type: PersonaTypeSchema,
  version: z.string().min(1),
  url: z.string().url(),
  // METHODS has 5 entries; arbitrary larger arrays are either bugs or attempts
  // to bloat the JSON column. Cap + dedupe to keep the row tidy.
  supported_methods: z
    .array(MethodSchema)
    .min(1)
    .max(20)
    .transform((arr) => Array.from(new Set(arr))),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({
  agent_id: z.string().min(1),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

/* -------- Sessions -------- */

export const SessionResponseSchema = z.object({
  session_id: z.string().min(1).nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const SessionPutSchema = z.object({
  session_id: z.string().min(1),
});
export type SessionPut = z.infer<typeof SessionPutSchema>;

/* -------- Method dispatch (coordinator -> agent) -------- */

export const DispatchRequestSchema = z.object({
  /**
   * Coordinator-assigned job id. The agent must use this id for its own job
   * record so that subsequent `/jobs/:id` lookups by the coordinator resolve
   * correctly. Also used by the coordinator's `jobs` table as the primary key
   * and by the partial unique index that prevents duplicate dispatch.
   */
  job_id: z.string().min(1),
  repo: RepoSchema,
  id: z.number().int().positive(),
  session_id: z.string().min(1).nullable(),
  /**
   * The persona name from the routing label segment (`agent:<persona_name>:<method>`).
   * For built-in personas this matches the agent's own `type` (and usually
   * `name`); for custom souls it matches the soul's `name`. The agent uses
   * THIS name when flipping its in-progress marker — not its own
   * frontmatter.name — because two custom souls of type 'custom' could
   * differ in name from each other and the routing label is the source of
   * truth for which label to operate on.
   */
  persona_name: PersonaNameSchema,
});
export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;

export const DispatchAcceptedSchema = z.object({
  job_id: z.string().min(1),
  agent_id: z.string().min(1),
  status: StatusSchema,
});
export type DispatchAccepted = z.infer<typeof DispatchAcceptedSchema>;

/* -------- Agent /status -------- */

export const CurrentJobSchema = z.object({
  id: z.string().min(1),
  method: MethodSchema,
  repo: RepoSchema,
  target_id: z.number().int().positive(),
  started_at: z.number().int(),
});
export type CurrentJob = z.infer<typeof CurrentJobSchema>;

export const AgentStatusResponseSchema = z.object({
  status: StatusSchema,
  agent_id: z.string().min(1).nullable(),
  current_job: CurrentJobSchema.nullable(),
  last_failure: FailureInfoSchema.nullable(),
});
export type AgentStatusResponse = z.infer<typeof AgentStatusResponseSchema>;

/* -------- KB write records -------- */

/** Maximum number of KB write records allowed per job slot. */
export const KB_WRITES_MAX = 64;
/** Error message emitted by Zod when the per-slot `kb_writes` cap is exceeded. */
export const KB_WRITES_MAX_MSG = `kb_writes capped at ${KB_WRITES_MAX} entries per job`;

/**
 * A single knowledge-base write action surfaced by an agent skill run.
 * Written by `agentify-kb append` (Phase 2); parsed from `extractArtifacts`
 * in the agent's live adapter. Fields are intentionally minimal so they
 * survive coordinator storage in the `artifacts` JSON column.
 *
 * Validation notes:
 * - `sha` regex `/^[0-9a-f]{7,64}$/` matches 7-char short SHAs through 40-char
 *   Git SHA-1 and is forward-compatible with 64-char SHA-256.
 * - `page` is intentionally NOT regex-tightened here; enforcement lives at the
 *   `agentify-kb` CLI boundary (see #276).
 */
export const KbWriteRecordSchema = z.object({
  /** Wiki page name, e.g. "KB-Tinkerer" or "KB-Global". */
  page: z.string().min(1),
  /** Whether the entry was written to the shared global page or a persona-scoped page. */
  scope: z.enum(['global', 'persona']),
  /** Byte length of the appended entry (non-negative integer). */
  bytes: z.number().int().nonnegative(),
  /**
   * Git commit SHA of the wiki push, populated when the push succeeded.
   * Regex matches 7-char short SHAs, 40-char Git SHA-1, and 64-char SHA-256.
   */
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/, 'must be a 7-64 char lowercase hex Git SHA')
    .optional(),
});
export type KbWriteRecord = z.infer<typeof KbWriteRecordSchema>;

/* -------- Job result -------- */

export const JobOutcomeSchema = z.enum([
  'success',
  'task_error',
  /** Job was dispatched but the agent has no record of it (e.g. agent restarted). */
  'orphaned',
  'sdk_failure',
  'auth_failure',
  'config_failure',
]);
export type JobOutcome = z.infer<typeof JobOutcomeSchema>;

export const JobArtifactsSchema = z
  .object({
    plan: z
      .object({
        child_issues: z.array(z.number().int().positive()),
        kb_writes: z.array(KbWriteRecordSchema).max(KB_WRITES_MAX, KB_WRITES_MAX_MSG).optional(),
      })
      .optional(),
    implement: z
      .object({
        branch: z.string().min(1),
        pr_number: z.number().int().positive(),
        kb_writes: z.array(KbWriteRecordSchema).max(KB_WRITES_MAX, KB_WRITES_MAX_MSG).optional(),
      })
      .optional(),
    review: z
      .object({
        review_id: z.number().int(),
        verdict: z.enum(['approved', 'changes_requested', 'commented']),
        kb_writes: z.array(KbWriteRecordSchema).max(KB_WRITES_MAX, KB_WRITES_MAX_MSG).optional(),
      })
      .optional(),
    address_review: z
      .object({
        commits_pushed: z.number().int().nonnegative(),
        rerequested: z.boolean(),
        kb_writes: z.array(KbWriteRecordSchema).max(KB_WRITES_MAX, KB_WRITES_MAX_MSG).optional(),
      })
      .optional(),
    merge: z
      .object({
        merged: z.boolean(),
        closed_issue: z.number().int().positive().optional(),
        kb_writes: z.array(KbWriteRecordSchema).max(KB_WRITES_MAX, KB_WRITES_MAX_MSG).optional(),
      })
      .optional(),
  })
  .partial();
export type JobArtifacts = z.infer<typeof JobArtifactsSchema>;

export const JobResultSchema = z.object({
  job_id: z.string().min(1),
  method: MethodSchema,
  repo: RepoSchema,
  target_id: z.number().int().positive(),
  outcome: JobOutcomeSchema,
  session_id: z.string().min(1).nullable(),
  duration_ms: z.number().int().nonnegative(),
  artifacts: JobArtifactsSchema,
  /** Final assistant text (truncated at the agent boundary). Operator-visible. */
  final_text: z.string().optional(),
  error: z.object({ message: z.string(), stack: z.string().optional() }).optional(),
  /** Anthropic SDK token counts for this run (maps input_tokens → usage_input, etc.). */
  usage_input: z.number().int().nonnegative().optional(),
  usage_output: z.number().int().nonnegative().optional(),
  usage_cache_read: z.number().int().nonnegative().optional(),
  usage_cache_write: z.number().int().nonnegative().optional(),
  /** Total cost USD as reported by the SDK for this run. */
  cost_usd: z.number().nonnegative().finite().optional(),
});
export type JobResult = z.infer<typeof JobResultSchema>;

/* -------- Health -------- */

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
  uptime_s: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
