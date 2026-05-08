import { z } from 'zod';
import { boolFlag } from '@agenti-fy/shared';

/**
 * Env shape required to run the E2E suite. All values must point at a real
 * sandbox: a GitHub App installed on a sandbox repo, an Anthropic API key,
 * and a running coordinator (doesn't have to be docker — local node procs work).
 */
const EnvSchema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1),
  GITHUB_USER: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),

  /** Sandbox repo as `<org>/<repo>`. */
  TEST_REPO: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),

  /** Coordinator base URL (e.g. http://localhost:8080). */
  COORDINATOR_URL: z.string().url().default('http://localhost:8080'),

  /** Persona to assign as the planner for this test (must be a registered IDLE agent). */
  TEST_PERSONA: z.string().default('orchestrator'),

  /** Max time (ms) to wait for the plan job to be dispatched. */
  TEST_DISPATCH_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /** Max time (ms) to wait for the plan job to complete. */
  TEST_COMPLETION_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),

  /** When `1`/`true`, close the test issue and any children at the end of the run. */
  CLEANUP: boolFlag(false),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const r = EnvSchema.safeParse(input);
  if (r.success) return r.data;
   
  console.error('Missing or invalid environment variables:');
  for (const issue of r.error.issues) {
     
    console.error(`  - ${issue.path.join('.') || '<env>'}: ${issue.message}`);
  }
  process.exit(2);
}
