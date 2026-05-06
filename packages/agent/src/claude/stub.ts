import { ulid } from 'ulid';
import type { Logger } from 'pino';
import type { JobArtifacts } from '@agentify/shared';
import type {
  ClaudeAdapter,
  SkillRunOptions,
  SkillRunOutput,
} from './adapter.js';

/**
 * Mock adapter that pretends to execute the skill, sleeps briefly so the
 * agent's BUSY state is observable, and returns plausible artifacts. Useful
 * for end-to-end tests of the agent ↔ coordinator pipeline without the real
 * Claude Code SDK or any GitHub side effects.
 */
export class StubClaudeAdapter implements ClaudeAdapter {
  constructor(
    private readonly logger: Logger,
    private readonly delayMs = 250,
  ) {}

  async run(opts: SkillRunOptions): Promise<SkillRunOutput> {
    this.logger.info(
      {
        method: opts.method,
        repo: opts.repo,
        target_id: opts.target_id,
        model: opts.model,
        session_resumed: opts.sessionId !== null,
        cwd: opts.cwd,
        prompt_chars: opts.systemPrompt.stable.length + opts.systemPrompt.volatile.length,
      },
      'stub-adapter: running skill',
    );
    await new Promise((r) => setTimeout(r, this.delayMs));

    const artifacts: JobArtifacts = stubArtifacts(opts);
    const sessionId = opts.sessionId ?? `sess_${ulid().toLowerCase()}`;

    return {
      outcome: 'success',
      sessionId,
      artifacts,
      finalText: `[stub] ${opts.method} on ${opts.repo}#${opts.target_id} ok`,
    };
  }
}

function stubArtifacts(opts: SkillRunOptions): JobArtifacts {
  switch (opts.method) {
    case 'plan':
      return { plan: { child_issues: [opts.target_id + 1, opts.target_id + 2] } };
    case 'implement':
      return {
        implement: {
          branch: `feat/stub/${opts.target_id}-stub-impl`,
          pr_number: opts.target_id + 1000,
        },
      };
    case 'review':
      return { review: { review_id: opts.target_id * 10, verdict: 'commented' } };
    case 'address_review':
      return { address_review: { commits_pushed: 1, rerequested: true } };
    case 'merge':
      return { merge: { merged: true, closed_issue: opts.target_id - 1 } };
  }
}
