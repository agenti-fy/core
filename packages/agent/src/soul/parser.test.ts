import { describe, it, expect } from 'vitest';
import { parseSoul } from './parser.js';

const baseFm = `---
name: tinkerer
type: tinkerer
version: 1.0.0
---`;

describe('parseSoul', () => {
  it('parses frontmatter + persona body', () => {
    const soul = parseSoul(`${baseFm}\n# The Tinkerer\nProse here.\n`);
    expect(soul.frontmatter.name).toBe('tinkerer');
    expect(soul.personaBody).toContain('Prose here.');
    expect(soul.skillOverrides).toEqual({});
  });

  it('extracts a single skill override', () => {
    const soul = parseSoul(
      `${baseFm}\n## Skill: plan\nDo the plan thing.\n`,
    );
    expect(soul.skillOverrides.plan).toBe('Do the plan thing.');
  });

  it('normalizes case and dashes in skill slugs', () => {
    const soul = parseSoul(
      `${baseFm}\n## Skill: Address-Review\nAddress it.\n`,
    );
    expect(soul.skillOverrides.address_review).toBe('Address it.');
  });

  it('treats empty override bodies as "use default" (does NOT overwrite)', () => {
    const soul = parseSoul(
      `${baseFm}\n## Skill: plan\n\n## Skill: implement\nImplement!\n`,
    );
    expect(soul.skillOverrides.plan).toBeUndefined();
    expect(soul.skillOverrides.implement).toBe('Implement!');
  });

  it('rejects SOUL.md without frontmatter', () => {
    expect(() => parseSoul('# bare\n')).toThrow();
  });

  it('rejects unknown skill slugs (silently — they are not METHODS)', () => {
    const soul = parseSoul(`${baseFm}\n## Skill: unknown-method\nblah\n`);
    expect(Object.keys(soul.skillOverrides)).toHaveLength(0);
  });
});
