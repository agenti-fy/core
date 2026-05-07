import { describe, it, expect } from 'vitest';
import {
  DispatchRequestSchema,
  JobArtifactsSchema,
  JobResultSchema,
  KbWriteRecordSchema,
  RegisterRequestSchema,
} from './rpc.js';

const VALID_REGISTER_BASE = {
  name: 'tinkerer',
  type: 'tinkerer' as const,
  version: '1.0.0',
  url: 'http://localhost:3000',
  supported_methods: ['implement' as const],
};

const VALID_DISPATCH_BASE = {
  job_id: 'job-123',
  repo: 'acme/api',
  id: 42,
  session_id: null,
  persona_name: 'tinkerer',
};

describe('RegisterRequestSchema.name uses PersonaNameSchema', () => {
  it('accepts valid persona names', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'tinkerer' }).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'my-custom-bot' }).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'bot_v2' }).success).toBe(true);
  });

  it('rejects shell-injection persona name $(echo pwned)', () => {
    const result = RegisterRequestSchema.safeParse({
      ...VALID_REGISTER_BASE,
      name: '$(echo pwned)',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('^[a-z][a-z0-9_-]{0,31}$');
    }
  });

  it('rejects empty string', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: '' }).success).toBe(false);
  });

  it('rejects names with uppercase letters', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'MyBot' }).success).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'my bot' }).success).toBe(false);
  });

  it('rejects names longer than 32 chars', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'a' + 'b'.repeat(32) }).success).toBe(false);
  });
});

describe('DispatchRequestSchema.persona_name uses PersonaNameSchema', () => {
  it('accepts valid persona names', () => {
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: 'tinkerer' }).success).toBe(true);
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: 'my-custom-bot' }).success).toBe(true);
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: 'bot_v2' }).success).toBe(true);
  });

  it('rejects shell-injection persona name $(echo pwned)', () => {
    const result = DispatchRequestSchema.safeParse({
      ...VALID_DISPATCH_BASE,
      persona_name: '$(echo pwned)',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('^[a-z][a-z0-9_-]{0,31}$');
    }
  });

  it('rejects empty string', () => {
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: '' }).success).toBe(false);
  });

  it('rejects names with shell metacharacters', () => {
    const bad = ['$(rm)', '`cmd`', 'a;b', 'a|b', 'a&b'];
    for (const name of bad) {
      expect(
        DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: name }).success,
        `should reject "${name}"`,
      ).toBe(false);
    }
  });

  it('rejects names with uppercase letters', () => {
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: 'BadName' }).success).toBe(false);
  });
});

const VALID_JOB_RESULT_BASE = {
  job_id: 'job-abc',
  method: 'implement' as const,
  repo: 'acme/api',
  target_id: 1,
  outcome: 'success' as const,
  session_id: null,
  duration_ms: 1000,
  artifacts: {},
};

/* ======================================================================== */
/*                           KbWriteRecordSchema                            */
/* ======================================================================== */

describe('KbWriteRecordSchema', () => {
  const VALID_KB_WRITE = {
    page: 'KB-Tinkerer',
    scope: 'persona' as const,
    bytes: 512,
  };

  it('accepts a fully-populated record (with sha)', () => {
    expect(
      KbWriteRecordSchema.safeParse({
        ...VALID_KB_WRITE,
        sha: 'abc123def456',
      }).success,
    ).toBe(true);
  });

  it('accepts a record without sha (sha is optional)', () => {
    expect(KbWriteRecordSchema.safeParse(VALID_KB_WRITE).success).toBe(true);
  });

  it('accepts scope "global"', () => {
    expect(
      KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, scope: 'global' }).success,
    ).toBe(true);
  });

  it('rejects empty page string', () => {
    const result = KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, page: '' });
    expect(result.success).toBe(false);
  });

  it('rejects negative bytes', () => {
    const result = KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, bytes: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects fractional bytes', () => {
    const result = KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, bytes: 1.5 });
    expect(result.success).toBe(false);
  });

  it('accepts bytes: 0 (zero-byte write is valid)', () => {
    expect(
      KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, bytes: 0 }).success,
    ).toBe(true);
  });

  it('rejects an invalid scope value', () => {
    const result = KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, scope: 'team' });
    expect(result.success).toBe(false);
  });

  it('rejects empty sha string (sha must be min(1) when present)', () => {
    const result = KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, sha: '' });
    expect(result.success).toBe(false);
  });

  // sha regex: /^[0-9a-f]{7,64}$/ — positive boundary cases
  it('accepts 7-char lowercase hex sha (short SHA boundary)', () => {
    expect(KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, sha: 'abc1234' }).success).toBe(true);
  });

  it('accepts 40-char lowercase hex sha (Git SHA-1)', () => {
    expect(
      KbWriteRecordSchema.safeParse({
        ...VALID_KB_WRITE,
        sha: 'a'.repeat(40),
      }).success,
    ).toBe(true);
  });

  it('accepts 64-char lowercase hex sha (SHA-256 forward-compat boundary)', () => {
    expect(
      KbWriteRecordSchema.safeParse({
        ...VALID_KB_WRITE,
        sha: 'f'.repeat(64),
      }).success,
    ).toBe(true);
  });

  // sha regex: negative cases
  it('rejects 6-char sha (below 7-char minimum)', () => {
    expect(KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, sha: 'abc123' }).success).toBe(false);
  });

  it('rejects uppercase hex sha', () => {
    expect(KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, sha: 'ABC1234' }).success).toBe(false);
  });

  it('rejects non-hex sha ("g".repeat(8))', () => {
    expect(KbWriteRecordSchema.safeParse({ ...VALID_KB_WRITE, sha: 'g'.repeat(8) }).success).toBe(false);
  });
});

/* ======================================================================== */
/*              JobArtifactsSchema — kb_writes integration                   */
/* ======================================================================== */

describe('JobArtifactsSchema kb_writes slots', () => {
  const KB_WRITE = { page: 'KB-Global', scope: 'global' as const, bytes: 128 };

  it('round-trips implement artifact with kb_writes populated', () => {
    const input = {
      implement: {
        branch: 'feat/x/1-foo',
        pr_number: 42,
        kb_writes: [{ ...KB_WRITE, sha: 'deadbeef' }],
      },
    };
    const result = JobArtifactsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.implement?.kb_writes).toHaveLength(1);
      expect(result.data.implement?.kb_writes?.[0]?.sha).toBe('deadbeef');
    }
  });

  it('round-trips plan artifact with kb_writes populated', () => {
    const input = {
      plan: { child_issues: [1, 2], kb_writes: [KB_WRITE] },
    };
    const result = JobArtifactsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plan?.kb_writes).toHaveLength(1);
    }
  });

  it('round-trips review artifact with kb_writes populated', () => {
    const input = {
      review: {
        review_id: 99,
        verdict: 'approved' as const,
        kb_writes: [KB_WRITE],
      },
    };
    const result = JobArtifactsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review?.kb_writes).toHaveLength(1);
    }
  });

  it('round-trips address_review artifact with kb_writes populated', () => {
    const input = {
      address_review: { commits_pushed: 2, rerequested: true, kb_writes: [KB_WRITE] },
    };
    const result = JobArtifactsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.address_review?.kb_writes).toHaveLength(1);
    }
  });

  it('round-trips merge artifact with kb_writes populated', () => {
    const input = {
      merge: { merged: true, closed_issue: 7, kb_writes: [KB_WRITE] },
    };
    const result = JobArtifactsSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.merge?.kb_writes).toHaveLength(1);
    }
  });

  it('remains valid when kb_writes is absent from a slot (optional)', () => {
    const input = {
      implement: { branch: 'feat/x/1-foo', pr_number: 7 },
    };
    expect(JobArtifactsSchema.safeParse(input).success).toBe(true);
  });

  it('rejects a kb_write entry with negative bytes inside an implement slot', () => {
    const input = {
      implement: {
        branch: 'feat/x/1-foo',
        pr_number: 7,
        kb_writes: [{ page: 'KB-Global', scope: 'global', bytes: -5 }],
      },
    };
    expect(JobArtifactsSchema.safeParse(input).success).toBe(false);
  });

  it('rejects a kb_write entry with empty page inside a plan slot', () => {
    const input = {
      plan: {
        child_issues: [1],
        kb_writes: [{ page: '', scope: 'global', bytes: 10 }],
      },
    };
    expect(JobArtifactsSchema.safeParse(input).success).toBe(false);
  });

  // kb_writes.max(64) — the cap is uniform across all five slots; we test via
  // the implement slot and trust the single schema definition applies equally.
  it('accepts exactly 64 kb_write entries in the implement slot', () => {
    const entries = Array.from({ length: 64 }, (_, i) => ({
      page: `KB-Page${i}`,
      scope: 'global' as const,
      bytes: 1,
    }));
    const input = {
      implement: { branch: 'feat/x/1-foo', pr_number: 1, kb_writes: entries },
    };
    expect(JobArtifactsSchema.safeParse(input).success).toBe(true);
  });

  it('rejects 65 kb_write entries in the implement slot (over the 64-entry cap)', () => {
    const entries = Array.from({ length: 65 }, (_, i) => ({
      page: `KB-Page${i}`,
      scope: 'global' as const,
      bytes: 1,
    }));
    const input = {
      implement: { branch: 'feat/x/1-foo', pr_number: 1, kb_writes: entries },
    };
    const result = JobArtifactsSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('kb_writes capped at 64 entries per job');
    }
  });
});

/* ======================================================================== */
/*                      JobResultSchema cost_usd                             */
/* ======================================================================== */

describe('JobResultSchema cost_usd rejects non-finite values', () => {
  it('accepts a normal cost value', () => {
    expect(JobResultSchema.safeParse({ ...VALID_JOB_RESULT_BASE, cost_usd: 0.0042 }).success).toBe(true);
  });

  it('accepts cost_usd: 0', () => {
    expect(JobResultSchema.safeParse({ ...VALID_JOB_RESULT_BASE, cost_usd: 0 }).success).toBe(true);
  });

  it('accepts cost_usd absent (field is optional)', () => {
    expect(JobResultSchema.safeParse({ ...VALID_JOB_RESULT_BASE }).success).toBe(true);
  });

  it('rejects Infinity', () => {
    expect(JobResultSchema.safeParse({ ...VALID_JOB_RESULT_BASE, cost_usd: Infinity }).success).toBe(false);
  });

  it('rejects -Infinity', () => {
    expect(JobResultSchema.safeParse({ ...VALID_JOB_RESULT_BASE, cost_usd: -Infinity }).success).toBe(false);
  });
});
