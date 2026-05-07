import { describe, it, expect } from 'vitest';
import { BUILTIN_PERSONAS, PERSONA_DEFAULTS } from '@agentify/shared';
import {
  WIZARD_PERSONAS,
  APP_PERMISSIONS,
  APP_DEFAULT_EVENTS,
} from './personas.js';

describe('WIZARD_PERSONAS', () => {
  it('has exactly 9 entries', () => {
    expect(WIZARD_PERSONAS).toHaveLength(9);
  });

  it('name fields match BUILTIN_PERSONAS in order', () => {
    const names = WIZARD_PERSONAS.map((p) => p.name);
    expect(names).toEqual([...BUILTIN_PERSONAS]);
  });

  it('every envPrefix is the uppercased name', () => {
    for (const persona of WIZARD_PERSONAS) {
      expect(persona.envPrefix).toBe(persona.name.toUpperCase());
    }
  });

  it('every appNameSuffix equals the persona name', () => {
    for (const persona of WIZARD_PERSONAS) {
      expect(persona.appNameSuffix).toBe(persona.name);
    }
  });

  it('every signature matches PERSONA_DEFAULTS', () => {
    for (const persona of WIZARD_PERSONAS) {
      expect(persona.signature).toBe(PERSONA_DEFAULTS[persona.name].signature);
    }
  });

  it('is frozen (runtime immutability)', () => {
    // The array itself should not be extensible
    expect(() => {
      (WIZARD_PERSONAS as WizardPersona[]).push({
        name: 'orchestrator',
        envPrefix: 'X',
        appNameSuffix: 'x',
        signature: 'x',
      });
    }).toThrow();
  });
});

// Import the interface for the runtime-freeze test above
import type { WizardPersona } from './personas.js';

describe('APP_PERMISSIONS', () => {
  it('matches the README contract exactly', () => {
    expect(APP_PERMISSIONS).toEqual({
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      metadata: 'read',
      wiki: 'write',
    });
  });

  it('has exactly the five documented permission keys', () => {
    expect(Object.keys(APP_PERMISSIONS)).toHaveLength(5);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(APP_PERMISSIONS)).toBe(true);
  });
});

describe('APP_DEFAULT_EVENTS', () => {
  it('is an empty array (poll not webhook)', () => {
    expect(APP_DEFAULT_EVENTS).toHaveLength(0);
    expect(Array.isArray(APP_DEFAULT_EVENTS)).toBe(true);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(APP_DEFAULT_EVENTS)).toBe(true);
  });
});
