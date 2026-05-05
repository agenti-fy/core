import { describe, it, expect } from 'vitest';
import { formatRepo, parseRepo } from './repo.js';

describe('parseRepo', () => {
  it('parses standard owner/repo', () => {
    expect(parseRepo('acme/api')).toEqual({ owner: 'acme', repo: 'api' });
  });
  it('preserves dots and hyphens in repo names', () => {
    expect(parseRepo('acme/dotnet.framework')).toEqual({
      owner: 'acme',
      repo: 'dotnet.framework',
    });
  });
  it('rejects empty parts', () => {
    expect(() => parseRepo('/api')).toThrow();
    expect(() => parseRepo('acme/')).toThrow();
    expect(() => parseRepo('acme')).toThrow();
  });
  it('rejects multi-slash paths', () => {
    expect(() => parseRepo('acme/api/extra')).toThrow();
  });
});

describe('formatRepo', () => {
  it('round-trips with parseRepo', () => {
    const ref = { owner: 'acme', repo: 'api' };
    expect(parseRepo(formatRepo(ref))).toEqual(ref);
  });
});
