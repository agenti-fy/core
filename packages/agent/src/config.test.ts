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
    expect(() =>
      loadConfig({ ...BASE_ENV, KB_GLOBAL_PAGE: 'some/path' }),
    ).toThrow(/must not contain slashes/);
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
