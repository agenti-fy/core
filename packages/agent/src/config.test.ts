import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

/** Minimal env that satisfies the non-optional coordinatorUrl / agentPublicUrl
 *  requirements while running with DISABLE_GITHUB=true (so GitHub credentials
 *  are not required). */
const BASE_ENV: NodeJS.ProcessEnv = {
  DISABLE_GITHUB: 'true',
  COORDINATOR_URL: 'http://coordinator:8080',
  AGENT_PUBLIC_URL: 'http://agent:8090',
};

describe('loadConfig — KB defaults', () => {
  it('applies all KB defaults when env vars are unset', () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.kbEnabled).toBe(true);
    expect(cfg.kbGlobalPage).toBe('KB-Global');
    expect(cfg.kbPagePrefix).toBe('KB-');
    expect(cfg.kbWriteRetryMax).toBe(3);
    expect(cfg.kbEntryMaxBytes).toBe(1024);
  });

  it('accepts env-var overrides for all KB fields', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      KB_ENABLED: 'false',
      KB_GLOBAL_PAGE: 'SharedKnowledge',
      KB_PAGE_PREFIX: 'Notes-',
      KB_WRITE_RETRY_MAX: '5',
      KB_ENTRY_MAX_BYTES: '2048',
    });
    expect(cfg.kbEnabled).toBe(false);
    expect(cfg.kbGlobalPage).toBe('SharedKnowledge');
    expect(cfg.kbPagePrefix).toBe('Notes-');
    expect(cfg.kbWriteRetryMax).toBe(5);
    expect(cfg.kbEntryMaxBytes).toBe(2048);
  });

  it('treats empty-string KB_ENABLED as disabled (empty = false per boolFlag)', () => {
    const cfg = loadConfig({ ...BASE_ENV, KB_ENABLED: '' });
    expect(cfg.kbEnabled).toBe(false);
  });

  it('treats "0" KB_ENABLED as disabled', () => {
    const cfg = loadConfig({ ...BASE_ENV, KB_ENABLED: '0' });
    expect(cfg.kbEnabled).toBe(false);
  });
});

describe('loadConfig — kbGlobalPage validation', () => {
  it('rejects a page name containing a slash', () => {
    // The regex allowlist now excludes slashes; the error message changed (#264).
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: 'some/path' }),
    ).toThrow();
  });

  it('rejects a page name ending with .md', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: 'KB-Global.md' }),
    ).toThrow(/must not end with .md/);
  });

  it('accepts a page name with no slash and no .md suffix', () => {
    const cfg = loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: 'SharedKB' });
    expect(cfg.kbGlobalPage).toBe('SharedKB');
  });

  // Attack-shape rejection cases added per #264 / #326 ─────────────────────
  it('rejects a page name containing shell metacharacters (semicolon)', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: 'foo; echo pwned' }),
    ).toThrow();
  });

  it('rejects a page name with a leading dot (.git)', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: '.git' }),
    ).toThrow();
  });

  it('rejects a page name containing backtick command substitution', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: 'foo`whoami`' }),
    ).toThrow();
  });

  it('rejects a page name containing dollar-paren command substitution', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: 'foo$(id)' }),
    ).toThrow();
  });

  it('rejects a page name containing a newline', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: 'foo\nbar' }),
    ).toThrow();
  });

  // Acceptance case — internal spaces must remain valid ────────────────────
  it('accepts a page name containing internal spaces', () => {
    const cfg = loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: 'My KB Page' });
    expect(cfg.kbGlobalPage).toBe('My KB Page');
  });
});

describe('loadConfig — kbPagePrefix validation', () => {
  it('rejects a prefix containing a space', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_PAGE_PREFIX: 'KB Page-' }),
    ).toThrow(/alphanumeric/);
  });

  it('rejects a prefix containing a slash', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_PAGE_PREFIX: 'KB/' }),
    ).toThrow(/alphanumeric/);
  });

  it('rejects a prefix containing an underscore', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_PAGE_PREFIX: 'KB_' }),
    ).toThrow(/alphanumeric/);
  });

  it('accepts a prefix with alphanumerics and dashes', () => {
    const cfg = loadConfig({ ...BASE_ENV, KB_PAGE_PREFIX: 'My-KB-' });
    expect(cfg.kbPagePrefix).toBe('My-KB-');
  });
});

describe('loadConfig — kbWriteRetryMax validation', () => {
  it('rejects zero (min is 1)', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_WRITE_RETRY_MAX: '0' }),
    ).toThrow();
  });

  it('accepts 1 (minimum)', () => {
    const cfg = loadConfig({ ...BASE_ENV, KB_WRITE_RETRY_MAX: '1' });
    expect(cfg.kbWriteRetryMax).toBe(1);
  });
});

describe('loadConfig — kbEntryMaxBytes validation', () => {
  it('rejects zero (must be positive)', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_ENTRY_MAX_BYTES: '0' }),
    ).toThrow();
  });

  it('accepts a positive value', () => {
    const cfg = loadConfig({ ...BASE_ENV, KB_ENTRY_MAX_BYTES: '512' });
    expect(cfg.kbEntryMaxBytes).toBe(512);
  });
});

describe('loadConfig — empty-string coercion for KB numeric fields', () => {
  it('falls back to schema defaults when KB_WRITE_RETRY_MAX and KB_ENTRY_MAX_BYTES are empty strings', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      KB_WRITE_RETRY_MAX: '',
      KB_ENTRY_MAX_BYTES: '',
    });
    expect(cfg.kbWriteRetryMax).toBe(3);
    expect(cfg.kbEntryMaxBytes).toBe(1024);
  });
});

describe('loadConfig — empty-string coercion for remaining numeric fields', () => {
  it('falls back to schema default when REGISTER_RETRY_MS is empty string', () => {
    const cfg = loadConfig({ ...BASE_ENV, REGISTER_RETRY_MS: '' });
    expect(cfg.registerRetryMs).toBe(2000);
  });

  it('falls back to schema default when REGISTER_MAX_ATTEMPTS is empty string', () => {
    const cfg = loadConfig({ ...BASE_ENV, REGISTER_MAX_ATTEMPTS: '' });
    expect(cfg.registerMaxAttempts).toBe(60);
  });

  it('falls back to schema default when HEARTBEAT_INTERVAL_MS is empty string', () => {
    const cfg = loadConfig({ ...BASE_ENV, HEARTBEAT_INTERVAL_MS: '' });
    expect(cfg.heartbeatIntervalMs).toBe(15000);
  });

  it('falls back to schema default when COORDINATOR_TIMEOUT_MS is empty string', () => {
    const cfg = loadConfig({ ...BASE_ENV, COORDINATOR_TIMEOUT_MS: '' });
    expect(cfg.coordinatorTimeoutMs).toBe(15000);
  });

  it('falls back to schema default when JOB_HISTORY_CAPACITY is empty string', () => {
    const cfg = loadConfig({ ...BASE_ENV, JOB_HISTORY_CAPACITY: '' });
    expect(cfg.jobHistoryCapacity).toBe(500);
  });

  it('falls back to schema default when CLAUDE_MAX_TURNS is empty string', () => {
    const cfg = loadConfig({ ...BASE_ENV, CLAUDE_MAX_TURNS: '' });
    expect(cfg.claudeMaxTurns).toBe(500);
  });

  it('falls back to schema default when CLAUDE_COST_LIMIT_USD is empty string', () => {
    const cfg = loadConfig({ ...BASE_ENV, CLAUDE_COST_LIMIT_USD: '' });
    expect(cfg.claudeCostLimitUsd).toBe(5.0);
  });

  it('falls back to global CLAUDE_MAX_TURNS when CLAUDE_MAX_TURNS_PLAN is empty string', () => {
    const cfg = loadConfig({ ...BASE_ENV, CLAUDE_MAX_TURNS_PLAN: '', CLAUDE_MAX_TURNS: '42' });
    expect(cfg.claudeMaxTurnsPlan).toBe(42);
  });

  it('falls back to schema default when both CLAUDE_MAX_TURNS_PLAN and CLAUDE_MAX_TURNS are empty strings', () => {
    const cfg = loadConfig({ ...BASE_ENV, CLAUDE_MAX_TURNS_PLAN: '', CLAUDE_MAX_TURNS: '' });
    expect(cfg.claudeMaxTurnsPlan).toBe(100);
  });
});

describe('loadConfig — claudeMaxTurns* precedence', () => {
  it('per-method env var wins over global CLAUDE_MAX_TURNS', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      CLAUDE_MAX_TURNS_PLAN: '77',
      CLAUDE_MAX_TURNS: '99',
    });
    expect(cfg.claudeMaxTurnsPlan).toBe(77);
  });

  it('global CLAUDE_MAX_TURNS wins over schema default when per-method is unset', () => {
    const cfg = loadConfig({ ...BASE_ENV, CLAUDE_MAX_TURNS: '42' });
    expect(cfg.claudeMaxTurnsPlan).toBe(42);
    expect(cfg.claudeMaxTurnsImplement).toBe(42);
    expect(cfg.claudeMaxTurnsReview).toBe(42);
    expect(cfg.claudeMaxTurnsAddressReview).toBe(42);
    expect(cfg.claudeMaxTurnsMerge).toBe(42);
  });

  it('schema defaults apply when no CLAUDE_MAX_TURNS* vars are set', () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.claudeMaxTurnsPlan).toBe(100);
    expect(cfg.claudeMaxTurnsImplement).toBe(250);
    expect(cfg.claudeMaxTurnsReview).toBe(60);
    expect(cfg.claudeMaxTurnsAddressReview).toBe(200);
    expect(cfg.claudeMaxTurnsMerge).toBe(50);
  });
});
