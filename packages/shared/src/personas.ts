import { z } from 'zod';

/** Allowlist: lowercase ASCII letter start, then lowercase alphanum / `_` / `-`, max 32 chars. */
export const PERSONA_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidPersonaName(s: string): boolean {
  return PERSONA_NAME_RE.test(s);
}

export const PersonaNameSchema = z
  .string()
  .regex(PERSONA_NAME_RE, 'Persona name must match ^[a-z][a-z0-9_-]{0,31}$');

export const BUILTIN_PERSONAS = [
  'orchestrator',
  'conductor',
  'theorist',
  'tinkerer',
  'optimizer',
  'glue',
  'skeptic',
  'crafter',
  'scribe',
] as const;

export type BuiltinPersona = (typeof BUILTIN_PERSONAS)[number];

export const PERSONA_TYPES = [...BUILTIN_PERSONAS, 'custom'] as const;
export const PersonaTypeSchema = z.enum(PERSONA_TYPES);
export type PersonaType = z.infer<typeof PersonaTypeSchema>;

export interface PersonaDefaults {
  emoji: string;
  title: string;
  signature: string;
  gitName: string;
  gitEmail: string;
}

export const PERSONA_DEFAULTS: Record<BuiltinPersona, PersonaDefaults> = {
  orchestrator: {
    emoji: '🎯',
    title: 'Project Manager',
    signature: '🎯 **The Orchestrator** · Project Manager',
    gitName: 'The Orchestrator',
    gitEmail: 'orchestrator@agentify.local',
  },
  conductor: {
    emoji: '🎭',
    title: 'Engineering Lead',
    signature: '🎭 **The Conductor** · Engineering Lead',
    gitName: 'The Conductor',
    gitEmail: 'conductor@agentify.local',
  },
  theorist: {
    emoji: '🧠',
    title: 'Systems Architect',
    signature: '🧠 **The Theorist** · Systems Architect',
    gitName: 'The Theorist',
    gitEmail: 'theorist@agentify.local',
  },
  tinkerer: {
    emoji: '🔧',
    title: 'Implementation Specialist',
    signature: '🔧 **The Tinkerer** · Implementation Specialist',
    gitName: 'The Tinkerer',
    gitEmail: 'tinkerer@agentify.local',
  },
  optimizer: {
    emoji: '⚡',
    title: 'Performance Specialist',
    signature: '⚡ **The Optimizer** · Performance Specialist',
    gitName: 'The Optimizer',
    gitEmail: 'optimizer@agentify.local',
  },
  glue: {
    emoji: '🔗',
    title: 'Integration Specialist',
    signature: '🔗 **The Glue** · Integration Specialist',
    gitName: 'The Glue',
    gitEmail: 'glue@agentify.local',
  },
  skeptic: {
    emoji: '🛡️',
    title: 'Security Reviewer',
    signature: '🛡️ **The Skeptic** · Security Reviewer',
    gitName: 'The Skeptic',
    gitEmail: 'skeptic@agentify.local',
  },
  crafter: {
    emoji: '🎨',
    title: 'UI/UX Specialist',
    signature: '🎨 **The Crafter** · UI/UX Specialist',
    gitName: 'The Crafter',
    gitEmail: 'crafter@agentify.local',
  },
  scribe: {
    emoji: '📝',
    title: 'Documentation Specialist',
    signature: '📝 **The Scribe** · Documentation Specialist',
    gitName: 'The Scribe',
    gitEmail: 'scribe@agentify.local',
  },
};

export function isBuiltinPersona(value: string): value is BuiltinPersona {
  return BUILTIN_PERSONAS.includes(value as BuiltinPersona);
}
