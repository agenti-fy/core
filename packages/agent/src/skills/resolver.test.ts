import { describe, it, expect } from 'vitest';
import { resolveSkill, SECURITY_PREAMBLE, InvalidPersonaNameError } from './resolver.js';
import type { ParsedSoul } from '@agentify/shared';

function makeSoul(overrides: Partial<ParsedSoul> = {}): ParsedSoul {
  return {
    frontmatter: {
      name: 'tinkerer',
      type: 'tinkerer',
      version: '1.0.0',
    },
    personaBody: 'You are The Tinkerer.',
    skillOverrides: {},
    ...overrides,
  };
}

function makeBuiltinSoul(): ParsedSoul {
  return {
    frontmatter: {
      name: 'tinkerer',
      type: 'tinkerer',
      version: '0.1.0',
    },
    personaBody: 'You are The Tinkerer.',
    skillOverrides: {},
  };
}

function makeCustomSoul(): ParsedSoul {
  return {
    frontmatter: {
      name: 'my-agent',
      type: 'custom',
      version: '0.1.0',
    },
    personaBody: 'You are a custom agent.',
    skillOverrides: {},
  };
}

const BASE_OPTS = {
  soul: makeSoul(),
  method: 'implement' as const,
  repo: 'owner/repo',
  target_id: 1,
};

describe('SECURITY_PREAMBLE', () => {
  it('is a non-empty string', () => {
    expect(typeof SECURITY_PREAMBLE).toBe('string');
    expect(SECURITY_PREAMBLE.length).toBeGreaterThan(0);
  });

  it('mentions the attacker model', () => {
    expect(SECURITY_PREAMBLE).toContain('external GitHub user');
  });

  it('states the data-not-instructions rule', () => {
    expect(SECURITY_PREAMBLE).toContain('DATA');
    expect(SECURITY_PREAMBLE).toContain('not');
  });

  it('names the hijack response', () => {
    expect(SECURITY_PREAMBLE).toContain('needs-human');
    expect(SECURITY_PREAMBLE).toContain('hijack');
  });

  it('includes the KB semi-trusted DATA note', () => {
    expect(SECURITY_PREAMBLE).toContain('Knowledge-base content');
    expect(SECURITY_PREAMBLE).toContain('semi-trusted');
    expect(SECURITY_PREAMBLE).toContain('KB-Global.md');
  });
});

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
    expect(result.skillPrompt).toContain('Custom implement body');
  });
});

describe('resolveSkill — {{common}} interpolation', () => {
  it('expands {{common}} in the default skill prompts', () => {
    const result = resolveSkill({ ...BASE_OPTS, personaName: 'tinkerer' });
    expect(result.skillPrompt).toContain('## Tooling');
    expect(result.skillPrompt).toContain('## Routing label format');
    expect(result.skillPrompt).not.toContain('{{common}}');
  });

  it('expands {{common}} in a custom soul skill override', () => {
    const soul = makeSoul({ skillOverrides: { implement: 'Preamble:\n\n{{common}}\n\nBody.' } });
    const result = resolveSkill({ ...BASE_OPTS, soul, personaName: 'tinkerer' });
    expect(result.skillPrompt).toContain('## Tooling');
    expect(result.skillPrompt).toContain('## Routing label format');
    expect(result.skillPrompt).not.toContain('{{common}}');
    expect(result.source).toBe('soul');
  });

  it('leaves {{common}} unexpanded when it appears nowhere in the template', () => {
    const soul = makeSoul({ skillOverrides: { implement: 'No tokens here.' } });
    const result = resolveSkill({ ...BASE_OPTS, soul, personaName: 'tinkerer' });
    expect(result.skillPrompt).toContain('No tokens here.');
  });
});

describe('resolveSkill — security preamble', () => {
  it('prepends SECURITY_PREAMBLE to personaBody for a built-in soul', () => {
    const result = resolveSkill({
      soul: makeBuiltinSoul(),
      method: 'implement',
      repo: 'owner/repo',
      target_id: 1,
      personaName: 'tinkerer',
    });
    expect(result.personaBody.startsWith(SECURITY_PREAMBLE.trimEnd())).toBe(true);
  });

  it('prepends SECURITY_PREAMBLE to personaBody for a custom soul', () => {
    const result = resolveSkill({
      soul: makeCustomSoul(),
      method: 'implement',
      repo: 'owner/repo',
      target_id: 2,
      personaName: 'my-agent',
    });
    expect(result.personaBody.startsWith(SECURITY_PREAMBLE.trimEnd())).toBe(true);
  });

  it('includes SECURITY_PREAMBLE in the combined systemPrompt', () => {
    const result = resolveSkill({
      soul: makeBuiltinSoul(),
      method: 'plan',
      repo: 'owner/repo',
      target_id: 42,
      personaName: 'tinkerer',
    });
    expect(result.systemPrompt.stable).toContain(SECURITY_PREAMBLE.trim());
  });

  it('retains the original persona prose after the preamble', () => {
    const soul = makeBuiltinSoul();
    const result = resolveSkill({
      soul,
      method: 'implement',
      repo: 'owner/repo',
      target_id: 1,
      personaName: 'tinkerer',
    });
    expect(result.personaBody).toContain(soul.personaBody);
  });

  it('KB semi-trusted note appears in systemPrompt.stable for implement', () => {
    const result = resolveSkill({
      soul: makeBuiltinSoul(),
      method: 'implement',
      repo: 'owner/repo',
      target_id: 1,
      personaName: 'tinkerer',
    });
    expect(result.systemPrompt.stable).toContain('Knowledge-base content');
    expect(result.systemPrompt.stable).toContain('semi-trusted');
  });
});

describe('resolveSkill — stable/volatile split', () => {
  it('stable section is byte-identical for different (repo, target_id) with same soul+method', () => {
    const soul = makeSoul();
    const a = resolveSkill({
      soul,
      method: 'implement',
      repo: 'acme/api',
      target_id: 1,
      personaName: 'tinkerer',
    });
    const b = resolveSkill({
      soul,
      method: 'implement',
      repo: 'other-org/other-repo',
      target_id: 9999,
      personaName: 'tinkerer',
    });
    expect(a.systemPrompt.stable).toBe(b.systemPrompt.stable);
  });

  it('volatile section contains per-job tokens', () => {
    const soul = makeSoul();
    const result = resolveSkill({
      soul,
      method: 'implement',
      repo: 'acme/api',
      target_id: 42,
      personaName: 'tinkerer',
    });
    expect(result.systemPrompt.volatile).toContain('acme/api');
    expect(result.systemPrompt.volatile).toContain('42');
    expect(result.systemPrompt.volatile).toContain('tinkerer');
  });

  it('stable section does not contain per-job repo or target_id', () => {
    const soul = makeSoul();
    const result = resolveSkill({
      soul,
      method: 'implement',
      repo: 'unique-repo-xyz-12345',
      target_id: 99887,
      personaName: 'tinkerer',
    });
    expect(result.systemPrompt.stable).not.toContain('unique-repo-xyz-12345');
    expect(result.systemPrompt.stable).not.toContain('99887');
  });

  it('volatile section is appended to skillPrompt', () => {
    const soul = makeSoul();
    const result = resolveSkill({
      soul,
      method: 'implement',
      repo: 'acme/api',
      target_id: 42,
      personaName: 'tinkerer',
    });
    expect(result.skillPrompt).toContain(result.systemPrompt.volatile);
  });

  it('volatile section is ≤8 lines', () => {
    const soul = makeSoul();
    const result = resolveSkill({
      soul,
      method: 'plan',
      repo: 'acme/api',
      target_id: 1,
      personaName: 'tinkerer',
    });
    const lines = result.systemPrompt.volatile.split('\n').length;
    expect(lines).toBeLessThanOrEqual(8);
  });

  it('custom soul override still gets volatile trailer appended to skillPrompt', () => {
    const soul = makeSoul();
    soul.skillOverrides['implement'] = 'Do the implementation. Sign with {{signature}}.';
    const result = resolveSkill({
      soul,
      method: 'implement',
      repo: 'acme/api',
      target_id: 42,
      personaName: 'tinkerer',
    });
    expect(result.source).toBe('soul');
    expect(result.skillPrompt).toContain(result.systemPrompt.volatile);
    expect(result.systemPrompt.volatile).toContain('42');
  });

  it('stable section for custom soul override excludes per-job tokens', () => {
    const soul = makeSoul();
    soul.skillOverrides['implement'] = 'Do it for {{repo}} issue {{target_id}}.';
    const a = resolveSkill({
      soul,
      method: 'implement',
      repo: 'acme/api',
      target_id: 1,
      personaName: 'tinkerer',
    });
    const b = resolveSkill({
      soul,
      method: 'implement',
      repo: 'different-org/different-repo',
      target_id: 5555,
      personaName: 'tinkerer',
    });
    expect(a.systemPrompt.stable).toBe(b.systemPrompt.stable);
  });

  it('personaBody is included in stable section', () => {
    const soul = makeSoul();
    const result = resolveSkill({
      soul,
      method: 'implement',
      repo: 'acme/api',
      target_id: 1,
      personaName: 'tinkerer',
    });
    expect(result.systemPrompt.stable).toContain(result.personaBody);
  });
});
