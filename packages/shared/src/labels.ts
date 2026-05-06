import { isBuiltinPersona, isValidPersonaName, type PersonaType } from './personas.js';
import { METHOD_PATHS, pathToMethod, type Method } from './methods.js';

/**
 * Combined-routing label format: `agent:<persona>:<method>`.
 *
 * Background: the previous format used two labels (`agent:<persona>` plus
 * `task:<method>`). That made multi-actor states impossible — if conductor
 * AND skeptic both needed to review a PR, the first to pick it up would
 * remove `task:review` and the second never sees it. The combined format
 * fixes this: a PR can carry `agent:conductor:review` AND `agent:skeptic:review`
 * AND `agent:scribe:review` etc. simultaneously, each evolves independently.
 *
 * In-progress markers: `agent:<persona>:<method>-in-progress`. Each agent
 * flips its OWN routing label to in-progress on accept; other agents'
 * labels on the same target are untouched.
 *
 * Method slugs use kebab-case (`address-review`) so the address-review
 * in-progress marker reads as `agent:tinkerer:address-review-in-progress`.
 */
const IN_PROGRESS_SUFFIX = '-in-progress';

/** Routing label, e.g. `agent:conductor:review`. */
export function routingLabel(persona: string, method: Method): string {
  return `agent:${persona}:${METHOD_PATHS[method]}`;
}

/** In-progress marker, e.g. `agent:conductor:review-in-progress`. */
export function inProgressLabel(persona: string, method: Method): string {
  return `agent:${persona}:${METHOD_PATHS[method]}${IN_PROGRESS_SUFFIX}`;
}

export interface ParsedRoutingLabel {
  /** Raw persona name from the label (matches the agent's `name` field for
   *  custom souls, or the `type` for built-ins). */
  persona: string;
  /** Bucketed for the dispatcher: built-in name maps to itself; otherwise 'custom'. */
  personaType: PersonaType;
  method: Method;
  /** True if this is the `-in-progress` form; false for the dispatchable form. */
  inProgress: boolean;
}

/**
 * Parse a single label. Returns null when the label isn't a routing label,
 * has an unknown method, or is malformed. Plain string parsing — no regex
 * backtracking — to keep `address-review-in-progress` deterministic.
 */
export function parseRoutingLabel(label: string): ParsedRoutingLabel | null {
  const PREFIX = 'agent:';
  if (!label.startsWith(PREFIX)) return null;
  const rest = label.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0 || colon === rest.length - 1) return null;
  const persona = rest.slice(0, colon);
  if (!isValidPersonaName(persona)) return null;
  let methodPart = rest.slice(colon + 1);
  let inProgress = false;
  if (methodPart.endsWith(IN_PROGRESS_SUFFIX)) {
    inProgress = true;
    methodPart = methodPart.slice(0, -IN_PROGRESS_SUFFIX.length);
  }
  const method = pathToMethod(methodPart);
  if (!method) return null;
  const personaType: PersonaType = isBuiltinPersona(persona) ? persona : 'custom';
  return { persona, personaType, method, inProgress };
}

/**
 * Octokit returns issue labels as `Array<string | { name?: string }>`. Normalize
 * to a flat list of non-empty strings, defending against undefined names.
 */
export function normalizeIssueLabels(
  raw: ReadonlyArray<string | { name?: string }> | undefined,
): string[] {
  if (!raw) return [];
  return raw
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter((l): l is string => typeof l === 'string' && l.length > 0);
}

/** System labels. */
export const HALT_LABEL = 'halt-agents';
export const NEEDS_HUMAN_LABEL = 'needs-human';
