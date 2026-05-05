import { z } from 'zod';

export const METHODS = ['plan', 'implement', 'review', 'address_review', 'merge'] as const;
export const MethodSchema = z.enum(METHODS);
export type Method = z.infer<typeof MethodSchema>;

/** URL path segment for each method (kebab-case where the enum uses snake_case). */
export const METHOD_PATHS: Record<Method, string> = {
  plan: 'plan',
  implement: 'implement',
  review: 'review',
  address_review: 'address-review',
  merge: 'merge',
};

const _pathToMethod: Record<string, Method | undefined> = Object.fromEntries(
  (Object.entries(METHOD_PATHS) as [Method, string][]).map(([m, p]) => [p, m]),
);

/**
 * Reverse lookup: URL path segment → method enum value. Returns undefined
 * for unknown paths (typed honestly — earlier `Record<string, Method>`
 * lied about runtime behavior).
 */
export function pathToMethod(path: string): Method | undefined {
  return _pathToMethod[path];
}

/** @deprecated use {@link pathToMethod} for type-honest lookups. */
export const PATH_TO_METHOD: Record<string, Method | undefined> = _pathToMethod;
