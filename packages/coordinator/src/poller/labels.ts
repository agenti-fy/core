import {
  HALT_LABEL,
  NEEDS_HUMAN_LABEL,
  inProgressLabel,
  parseRoutingLabel,
  type ParsedRoutingLabel,
} from '@agenti-fy/shared';

/**
 * Pull every dispatchable routing pair off an issue's labels. The combined-label
 * format (`agent:<persona>:<method>`) means a single target can carry multiple
 * routings simultaneously — e.g. a PR with `agent:conductor:review` AND
 * `agent:skeptic:review` is dispatched twice independently. Per-routing
 * lifecycle: each `(persona, method)` is dispatched only when its OWN
 * in-progress marker isn't already set; other personas' in-progress markers
 * on the same target don't block.
 *
 * Always returns [] when `needs-human` is set: per spec §8.1 the label takes
 * the item out of the routing pool until a human removes it.
 */
export function parseRoutingLabels(labels: readonly string[]): ParsedRoutingLabel[] {
  if (labels.includes(NEEDS_HUMAN_LABEL)) return [];

  const out: ParsedRoutingLabel[] = [];
  for (const label of labels) {
    const parsed = parseRoutingLabel(label);
    if (!parsed) continue;
    if (parsed.inProgress) continue; // in-progress markers aren't dispatchable
    // If THIS (persona, method)'s in-progress marker is set, the work is
    // already in flight — don't re-dispatch.
    if (labels.includes(inProgressLabel(parsed.persona, parsed.method))) continue;
    out.push(parsed);
  }
  return out;
}

export function hasHaltLabel(labels: readonly string[]): boolean {
  return labels.includes(HALT_LABEL);
}
