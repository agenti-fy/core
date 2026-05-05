import { z } from 'zod';
import { MethodSchema } from './methods.js';
import { PersonaTypeSchema } from './personas.js';

export const SoulFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Soul name must be alphanumeric, dashes, or underscores'),
  type: PersonaTypeSchema,
  version: z.string().min(1),
  // Git identity is all-or-nothing: either both name+email or neither.
  git: z
    .object({
      name: z.string().min(1),
      email: z.string().email(),
    })
    .optional(),
  signature: z.string().min(1).optional(),
  models: z
    .object({
      plan: z.string().min(1).optional(),
      implement: z.string().min(1).optional(),
      review: z.string().min(1).optional(),
      address_review: z.string().min(1).optional(),
      merge: z.string().min(1).optional(),
    })
    .optional(),
  supported_methods: z.array(MethodSchema).min(1).optional(),
});

export type SoulFrontmatter = z.infer<typeof SoulFrontmatterSchema>;

/** A parsed SOUL.md: frontmatter + persona body + per-method skill overrides. */
export interface ParsedSoul {
  frontmatter: SoulFrontmatter;
  /** The free-form persona prose (without frontmatter and without skill override sections). */
  personaBody: string;
  /** Inline `## Skill: <method>` overrides keyed by method name. */
  skillOverrides: Partial<Record<z.infer<typeof MethodSchema>, string>>;
}
