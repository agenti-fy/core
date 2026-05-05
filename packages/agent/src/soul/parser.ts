import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  METHODS,
  type Method,
  type ParsedSoul,
  SoulFrontmatterSchema,
} from '@agentify/shared';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
/** `## Skill: <slug>` — slug must be ASCII letters, dashes, or underscores. */
const SKILL_HEADING_RE = /^##\s+Skill:\s+([A-Za-z_-]+)\s*$/;

export function parseSoul(text: string): ParsedSoul {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) {
    throw new Error('SOUL.md is missing required YAML frontmatter (--- … ---)');
  }
  const yamlBlock = m[1] ?? '';
  const body = m[2] ?? '';

  const raw = parseYaml(yamlBlock) as unknown;
  const frontmatter = SoulFrontmatterSchema.parse(raw);

  const { personaBody, skillOverrides } = splitBodyAndSkills(body);

  return { frontmatter, personaBody, skillOverrides };
}

export function loadSoulFromFile(path: string): ParsedSoul {
  const text = readFileSync(path, 'utf8');
  return parseSoul(text);
}

interface SplitResult {
  personaBody: string;
  skillOverrides: Partial<Record<Method, string>>;
}

function splitBodyAndSkills(body: string): SplitResult {
  const lines = body.split(/\r?\n/);
  const sections: { method: Method | null; lines: string[] }[] = [{ method: null, lines: [] }];

  for (const line of lines) {
    const heading = SKILL_HEADING_RE.exec(line);
    if (heading) {
      // Normalize: lowercase, dashes → underscores. So "Address-Review",
      // "address-review", "ADDRESS_REVIEW" all become "address_review".
      const slug = heading[1]!.toLowerCase().replace(/-/g, '_');
      if ((METHODS as readonly string[]).includes(slug)) {
        sections.push({ method: slug as Method, lines: [] });
        continue;
      }
    }
    sections[sections.length - 1]!.lines.push(line);
  }

  const personaBody = (sections[0]?.lines ?? []).join('\n').trim();
  const skillOverrides: Partial<Record<Method, string>> = {};
  for (const s of sections.slice(1)) {
    if (!s.method) continue;
    const content = s.lines.join('\n').trim();
    // Empty override = "use default"; do not silently nuke the bundled prompt.
    if (content.length > 0) skillOverrides[s.method] = content;
  }
  return { personaBody, skillOverrides };
}
