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

  describe('charset rejection', () => {
    it("rejects single-quote in repo segment", () => {
      expect(() => parseRepo("acme/api'")).toThrow(/disallowed characters/);
    });
    it("rejects single-quote in owner segment", () => {
      expect(() => parseRepo("ac'me/api")).toThrow(/disallowed characters/);
    });
    it('rejects space in owner segment', () => {
      expect(() => parseRepo('ac me/api')).toThrow(/disallowed characters/);
    });
    it('rejects space in repo segment', () => {
      expect(() => parseRepo('acme/my repo')).toThrow(/disallowed characters/);
    });
    it('rejects semicolon in repo segment', () => {
      expect(() => parseRepo('acme/api;ls')).toThrow(/disallowed characters/);
    });
    it('rejects dollar sign in repo segment', () => {
      expect(() => parseRepo('acme/api$PWD')).toThrow(/disallowed characters/);
    });
    it('rejects backtick in repo segment', () => {
      expect(() => parseRepo('acme/api`id`')).toThrow(/disallowed characters/);
    });
    it('rejects backslash in repo segment', () => {
      expect(() => parseRepo('acme/api\\n')).toThrow(/disallowed characters/);
    });
    it('rejects pipe in repo segment', () => {
      expect(() => parseRepo('acme/api|cat')).toThrow(/disallowed characters/);
    });
    it('rejects ampersand in repo segment', () => {
      expect(() => parseRepo('acme/api&ls')).toThrow(/disallowed characters/);
    });
    it('rejects parentheses in repo segment', () => {
      expect(() => parseRepo('acme/api()')).toThrow(/disallowed characters/);
    });
    it('rejects angle brackets in repo segment', () => {
      expect(() => parseRepo('acme/api<>')).toThrow(/disallowed characters/);
    });
  });
});

describe('formatRepo', () => {
  it('round-trips with parseRepo', () => {
    const ref = { owner: 'acme', repo: 'api' };
    expect(parseRepo(formatRepo(ref))).toEqual(ref);
  });
});
