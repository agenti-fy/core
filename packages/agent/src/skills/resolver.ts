import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PERSONA_DEFAULTS,
  isBuiltinPersona,
  type Method,
  type ParsedSoul,
} from '@agentify/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FILE_FOR_METHOD: Record<Method, string> = {
  plan: 'plan.md',
  implement: 'implement.md',
  review: 'review.md',
  address_review: 'address-review.md',
  merge: 'merge.md',
};

const defaultCache: Partial<Record<Method, string>> = {};
const personaBodyCache = new Map<string, string>();

function loadDefaultSkill(method: Method): string {
  const cached = defaultCache[method];
  if (cached !== undefined) return cached;
  const path = join(__dirname, 'defaults', FILE_FOR_METHOD[method]);
  const text = readFileSync(path, 'utf8');
  defaultCache[method] = text;
  return text;
}

export interface ResolvedSkill {
  /** Persona prose. Passed to the Agent SDK as the `systemPrompt`. */
  personaBody: string;
  /** Per-method instructions with template tokens filled in. Passed to the SDK as the user message. */
  skillPrompt: string;
  /**
   * Convenience: persona + skill concatenated. Used by the StubClaudeAdapter,
   * by tests, and as a fallback for adapters that don't separate roles.
   */
  systemPrompt: string;
  /** Whether the skill body came from the SOUL.md override or the bundled default. */
  source: 'soul' | 'default';
}

export interface ResolveOptions {
  soul: ParsedSoul;
  method: Method;
  repo: string;
  target_id: number;
  /**
   * Routing-label persona segment. Used to interpolate `{{persona}}` in
   * skill prompts (e.g. `--remove-label "agent:{{persona}}:review"`). For
   * built-ins this equals the soul's `type`, but for custom souls it
   * matches the soul's `name` instead — using `type` for custom souls
   * would interpolate the literal `"custom"` and break the label.
   */
  personaName: string;
}

/**
 * Build the prompt for a single skill invocation. The persona body comes from
 * the SOUL (or bundled default for built-ins); the skill body comes from the
 * SOUL override (`## Skill: <method>`) when present, otherwise the bundled
 * default. Template tokens like `{{repo}}` and `{{target_id}}` are interpolated.
 */
export function resolveSkill(opts: ResolveOptions): ResolvedSkill {
  const personaBody = personaBodyFor(opts.soul);

  const overridden = opts.soul.skillOverrides[opts.method];
  const skillTemplate = overridden ?? loadDefaultSkill(opts.method);
  const skillPrompt = interpolate(skillTemplate, {
    repo: opts.repo,
    target_id: String(opts.target_id),
    agent_name: opts.soul.frontmatter.name,
    persona: opts.personaName,
    signature: signatureFor(opts.soul),
  });

  const systemPrompt =
    `${personaBody.trim()}\n\n---\n\n${skillPrompt.trim()}\n`;

  return {
    personaBody: personaBody.trim(),
    skillPrompt: skillPrompt.trim(),
    systemPrompt,
    source: overridden ? 'soul' : 'default',
  };
}

function personaBodyFor(soul: ParsedSoul): string {
  if (soul.personaBody.length > 0) return soul.personaBody;
  // Key by `${type}:${name}` so two custom souls (both type=custom) don't
  // share the cached body. After /reset swaps soulRef to a renamed custom
  // soul, the new name's cache miss correctly synthesizes a fresh body.
  const cacheKey = `${soul.frontmatter.type}:${soul.frontmatter.name}`;
  const cached = personaBodyCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let body: string;
  if (isBuiltinPersona(soul.frontmatter.type)) {
    const path = join(__dirname, '..', 'personas', `${soul.frontmatter.type}.md`);
    try {
      body = readFileSync(path, 'utf8');
    } catch {
      // Fallback: synthesize a one-line persona from defaults so we never
      // ship an empty system prompt.
      const def = PERSONA_DEFAULTS[soul.frontmatter.type];
      body = `You are ${def.gitName} — ${def.title}.`;
    }
  } else {
    body = `You are ${soul.frontmatter.name}.`;
  }
  personaBodyCache.set(cacheKey, body);
  return body;
}

function signatureFor(soul: ParsedSoul): string {
  if (soul.frontmatter.signature) return soul.frontmatter.signature;
  if (isBuiltinPersona(soul.frontmatter.type)) {
    return PERSONA_DEFAULTS[soul.frontmatter.type].signature;
  }
  return soul.frontmatter.name;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : `{{${key}}}`;
  });
}

/** Pick the model the SOUL declared for this method (or undefined → SDK default). */
export function modelForMethod(soul: ParsedSoul, method: Method): string | undefined {
  return soul.frontmatter.models?.[method];
}
