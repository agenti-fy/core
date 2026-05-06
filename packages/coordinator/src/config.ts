import { z } from 'zod';
import { boolFlag } from '@agentify/shared';

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  host: z.string().default('0.0.0.0'),
  dataDir: z.string().default('/data'),
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Required when disableGithub=false; checked in the superRefine below so
  // the agent can boot offline (DISABLE_GITHUB=true) without dummy values.
  githubAppId: z.string().optional(),
  githubAppPrivateKey: z.string().optional(),
  githubAppInstallationId: z.string().optional(),
  githubUser: z.string().optional(),

  defaultPollIntervalSeconds: z.coerce.number().int().positive().default(30),
  installationRefreshSeconds: z.coerce.number().int().positive().default(300),
  jobCompletionPollSeconds: z.coerce.number().int().positive().default(5),
  workPollSeconds: z.coerce.number().int().positive().default(30),

  /** Drop `failed_to_dispatch` rows older than this many days during periodic GC. */
  failedDispatchRetentionDays: z.coerce.number().int().positive().default(7),

  /** Drop `complete`/`failed` rows older than this many days during periodic GC. */
  completedJobRetentionDays: z.coerce.number().int().positive().default(30),

  /**
   * In-progress label sweeper. The sweeper finds issues whose `task:*-in-progress`
   * label is older than `staleJobTimeoutSeconds` AND have no active job, and
   * restores their routing labels so a fresh dispatch picks them up.
   *
   * Default: 1800s (30 min) timeout, swept every 600s (10 min).
   */
  staleJobTimeoutSeconds: z.coerce.number().int().positive().default(30 * 60),
  staleJobSweepSeconds: z.coerce.number().int().positive().default(10 * 60),

  /**
   * Plan-completion poller. Scans open plans, updates parent body checklists,
   * and closes the parent issue when all children are closed.
   */
  planCompletionPollSeconds: z.coerce.number().int().positive().default(60),

  /**
   * PR review monitor. Walks open PRs and applies routing labels deterministically
   * based on review state (CHANGES_REQUESTED → address-review, all-approved → merge,
   * otherwise → reviewer labels).
   */
  prMonitorIntervalSeconds: z.coerce.number().int().positive().default(30),
  /**
   * Maximum number of re-review cycles per PR after the initial review.
   * When the cap is reached the PR gets `needs-human` and automated routing stops.
   */
  prMaxReviewCycles: z.coerce.number().int().positive().default(5),
  /** Required reviewers per PR — every one must approve on current HEAD before merge gate fires. */
  prMonitorRequiredReviewers: z
    .preprocess(
      (v) =>
        typeof v === 'string'
          ? v
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : v,
      z.array(z.string()),
    )
    .default(['conductor', 'skeptic', 'scribe', 'crafter']),

  /**
   * If true, the coordinator skips constructing the GitHub client and the
   * GitHub-driven loops. Useful for tests/smoke runs where no real App
   * credentials are available.
   */
  disableGithub: boolFlag(false),
}).superRefine((cfg, ctx) => {
  if (cfg.disableGithub) return;
  for (const key of [
    'githubAppId',
    'githubAppPrivateKey',
    'githubAppInstallationId',
    'githubUser',
  ] as const) {
    if (!cfg[key] || cfg[key].length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required unless DISABLE_GITHUB=true`,
      });
    }
  }
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    port: env.PORT,
    host: env.HOST,
    dataDir: env.DATA_DIR,
    logLevel: env.LOG_LEVEL,
    githubAppId: env.GITHUB_APP_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID,
    githubUser: env.GITHUB_USER,
    defaultPollIntervalSeconds: env.DEFAULT_POLL_INTERVAL_S,
    installationRefreshSeconds: env.INSTALLATION_REFRESH_S,
    jobCompletionPollSeconds: env.JOB_COMPLETION_POLL_S,
    workPollSeconds: env.WORK_POLL_S,
    failedDispatchRetentionDays: env.FAILED_DISPATCH_RETENTION_DAYS,
    completedJobRetentionDays: env.COMPLETED_JOB_RETENTION_DAYS,
    staleJobTimeoutSeconds: env.STALE_JOB_TIMEOUT_S,
    staleJobSweepSeconds: env.STALE_JOB_SWEEP_S,
    planCompletionPollSeconds: env.PLAN_COMPLETION_POLL_S,
    prMonitorIntervalSeconds: env.PR_MONITOR_INTERVAL_S,
    prMonitorRequiredReviewers: env.PR_MONITOR_REQUIRED_REVIEWERS,
    prMaxReviewCycles: env.PR_MAX_REVIEW_CYCLES,
    disableGithub: env.DISABLE_GITHUB,
  });
}
