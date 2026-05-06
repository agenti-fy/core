import { describe, it, expect } from 'vitest';
import { BUILTIN_PERSONAS, isValidPersonaName, PersonaNameSchema, PERSONA_NAME_RE } from './personas.js';

describe('PERSONA_NAME_RE / isValidPersonaName', () => {
  it('accepts all 9 built-in persona names', () => {
    for (const name of BUILTIN_PERSONAS) {
      expect(isValidPersonaName(name), `built-in "${name}" should be valid`).toBe(true);
    }
  });

  it('accepts valid custom names', () => {
    expect(isValidPersonaName('a')).toBe(true);
    expect(isValidPersonaName('my-bot')).toBe(true);
    expect(isValidPersonaName('my_bot')).toBe(true);
    expect(isValidPersonaName('bot123')).toBe(true);
    // exactly 32 chars
    expect(isValidPersonaName('a' + 'b'.repeat(31))).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidPersonaName('')).toBe(false);
  });

  it('rejects names starting with a digit', () => {
    expect(isValidPersonaName('1bot')).toBe(false);
  });

  it('rejects names starting with a hyphen', () => {
    expect(isValidPersonaName('-bot')).toBe(false);
  });

  it('rejects names starting with an underscore', () => {
    expect(isValidPersonaName('_bot')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(isValidPersonaName('MyBot')).toBe(false);
    expect(isValidPersonaName('BOT')).toBe(false);
  });

  it('rejects names longer than 32 chars', () => {
    expect(isValidPersonaName('a' + 'b'.repeat(32))).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isValidPersonaName('my bot')).toBe(false);
  });

  it('rejects shell metacharacters', () => {
    const bad = ['$', '`', ';', '&', '|', '<', '>', '\\', "'", '"', '(', ')'];
    for (const ch of bad) {
      expect(isValidPersonaName(`a${ch}b`), `should reject "${ch}"`).toBe(false);
    }
  });

  it('rejects control characters (NUL, newline)', () => {
    expect(isValidPersonaName('a\x00b')).toBe(false);
    expect(isValidPersonaName('a\nb')).toBe(false);
  });

  it('rejects unicode characters', () => {
    expect(isValidPersonaName('böt')).toBe(false);
    expect(isValidPersonaName('机器人')).toBe(false);
  });

  it('rejects the injection example from the issue', () => {
    expect(isValidPersonaName('$(rm -rf /)')).toBe(false);
  });
});

describe('PersonaNameSchema', () => {
  it('parses valid names successfully', () => {
    for (const name of BUILTIN_PERSONAS) {
      expect(PersonaNameSchema.safeParse(name).success).toBe(true);
    }
    expect(PersonaNameSchema.safeParse('my-custom-bot').success).toBe(true);
  });

  it('fails for invalid names with a descriptive error', () => {
    const result = PersonaNameSchema.safeParse('Bad Name!');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('^[a-z][a-z0-9_-]{0,31}$');
    }
  });
});

describe('PERSONA_NAME_RE anchoring', () => {
  it('does not match on a substring — anchor is required', () => {
    expect(PERSONA_NAME_RE.test('ok\nbad')).toBe(false);
    expect(PERSONA_NAME_RE.test(' leading')).toBe(false);
    expect(PERSONA_NAME_RE.test('trailing ')).toBe(false);
  });
});
