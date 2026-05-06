import { describe, it, expect } from 'vitest';
import type { ParsedSoul } from '@agentify/shared';
import { resolveSkill, InvalidPersonaNameError } from './resolver.js';

function makeSoul(overrides: Partial<ParsedSoul> = {}): ParsedSoul {
  return {
    frontmatter: {
      name: 'tinkerer',
      type: 'tinkerer',
      version: '1.0.0',
    },
    personaBody: 'You are the tinkerer.',
    skillOverrides: {},
    ...overrides,
  };
}

const BASE_OPTS = {
  soul: makeSoul(),
  method: 'implement' as const,
  repo: 'owner/repo',
  target_id: 1,
};

describe('resolveSkill — personaName validation', () => {
  it('accepts a valid lowercase persona name', () => {
    const result = resolveSkill({ ...BASE_OPTS, personaName: 'tinkerer' });
    expect(result.skillPrompt).toContain('tinkerer');
    expect(result.source).toBe('default');
  });

  it('accepts all built-in persona names', () => {
    const builtins = [
      'orchestrator', 'conductor', 'theorist', 'tinkerer',
      'optimizer', 'glue', 'skeptic', 'crafter', 'scribe',
    ];
    for (const name of builtins) {
      expect(
        () => resolveSkill({ ...BASE_OPTS, personaName: name }),
        `built-in "${name}" should be accepted`,
      ).not.toThrow();
    }
  });

  it('throws InvalidPersonaNameError for a shell-injection payload', () => {
    expect(() =>
      resolveSkill({ ...BASE_OPTS, personaName: '$(rm -rf /)' }),
    ).toThrowError(InvalidPersonaNameError);
  });

  it('throws for names with semicolons', () => {
    expect(() =>
      resolveSkill({ ...BASE_OPTS, personaName: 'a;b' }),
    ).toThrowError(InvalidPersonaNameError);
  });

  it('throws for names with backticks', () => {
    expect(() =>
      resolveSkill({ ...BASE_OPTS, personaName: 'a`b`c' }),
    ).toThrowError(InvalidPersonaNameError);
  });

  it('throws for names with pipe characters', () => {
    expect(() =>
      resolveSkill({ ...BASE_OPTS, personaName: 'a|b' }),
    ).toThrowError(InvalidPersonaNameError);
  });

  it('throws for names with uppercase letters', () => {
    expect(() =>
      resolveSkill({ ...BASE_OPTS, personaName: 'MyBot' }),
    ).toThrowError(InvalidPersonaNameError);
  });

  it('throws for empty string', () => {
    expect(() =>
      resolveSkill({ ...BASE_OPTS, personaName: '' }),
    ).toThrowError(InvalidPersonaNameError);
  });

  it('throws for names exceeding 32 chars', () => {
    expect(() =>
      resolveSkill({ ...BASE_OPTS, personaName: 'a' + 'b'.repeat(32) }),
    ).toThrowError(InvalidPersonaNameError);
  });

  it('throws for names starting with a digit', () => {
    expect(() =>
      resolveSkill({ ...BASE_OPTS, personaName: '1bot' }),
    ).toThrowError(InvalidPersonaNameError);
  });

  it('includes the invalid name in the error message', () => {
    let caught: unknown;
    try {
      resolveSkill({ ...BASE_OPTS, personaName: 'bad name!' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidPersonaNameError);
    expect((caught as InvalidPersonaNameError).message).toContain('"bad name!"');
  });

  it('error message mentions the regex constraint', () => {
    let caught: unknown;
    try {
      resolveSkill({ ...BASE_OPTS, personaName: 'Bad!' });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('^[a-z][a-z0-9_-]{0,31}$');
  });

  it('does NOT silently fall back to a default — the error propagates', () => {
    expect(() =>
      resolveSkill({ ...BASE_OPTS, personaName: 'UPPERCASE' }),
    ).toThrow();
  });
});

describe('resolveSkill — positive control with skill override', () => {
  it('uses the soul skill override when present', () => {
    const soul = makeSoul({ skillOverrides: { implement: 'Custom implement body {{persona}}.' } });
    const result = resolveSkill({ ...BASE_OPTS, soul, personaName: 'tinkerer' });
    expect(result.source).toBe('soul');
    expect(result.skillPrompt).toBe('Custom implement body tinkerer.');
  });
});
