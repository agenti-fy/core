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

/**
 * Dispatch priority for each method. **Higher number = dispatched first**
 * within a per-repo bucket.
 *
 * Source-of-truth ordering for #408:
 *   `merge > address_review > review > implement > plan`
 *
 * Rationale: lifecycle-late work (merging an approved PR, responding to review
 * feedback) should drain before lifecycle-early work (planning fresh issues)
 * begins, because draining late work releases agent capacity and shrinks
 * sibling-PR review/merge windows.
 *
 * Do NOT derive priority from the index of a value in the {@link METHODS}
 * array — `METHODS` is used for SQL CHECK constraints, route registration, and
 * validation and must not carry implicit ordering semantics.
 */
export const METHOD_PRIORITY: Record<Method, number> = {
  merge: 5,
  address_review: 4,
  review: 3,
  implement: 2,
  plan: 1,
};

/**
 * Comparator for `Array.prototype.sort` that orders methods by descending
 * dispatch priority (higher-priority method sorts earlier / closer to index 0).
 *
 * Returns a negative number when `a` has higher priority than `b`
 * (so `a` sorts before `b`), zero when equal, and positive when `b` has higher
 * priority than `a`.
 *
 * Intended for use as the primary comparator in `dispatchBatch`'s per-repo
 * bucket sort (see #408).
 *
 * @example
 * ['plan', 'merge', 'review', 'implement', 'address_review']
 *   .sort(compareMethodsByPriority)
 * // => ['merge', 'address_review', 'review', 'implement', 'plan']
 */
export function compareMethodsByPriority(a: Method, b: Method): number {
  return METHOD_PRIORITY[b] - METHOD_PRIORITY[a];
}
