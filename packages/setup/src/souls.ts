/**
 * souls.ts — read the bundled default soul files from the package's `dist/souls/`
 * directory.
 *
 * Background: the wizard ships nine default soul files (one per built-in
 * persona) so operators who installed via `npx @agenti-fy/setup` can run
 * `docker compose up` without ever cloning the source repo. The soul
 * frontmatter (name / type / version / git identity / model pins) is
 * authoritative; the persona body is empty, deferring to the agent image's
 * built-in `personas/<type>.md` lookup.
 *
 * Build wiring: `pnpm copy-assets` (in `packages/setup/package.json`) copies
 * `<repo-root>/souls/*.md` into `packages/setup/dist/souls/` before publish.
 * The `files` array in package.json includes `dist`, so the bundled souls
 * ride along with the published tarball.
 *
 * Runtime resolution uses `import.meta.url` rather than a hard-coded path
 * because the package can be installed at arbitrary paths (`npx` cache,
 * workspaces, global install, etc.).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PERSONAS, type BuiltinPersona } from '@agenti-fy/shared';

// dist/souls.js → ../souls (sibling of compiled JS modules)
const __dirname = dirname(fileURLToPath(import.meta.url));
const SOULS_DIR = join(__dirname, 'souls');

/**
 * Read every bundled soul file into memory. Returns a Record keyed by
 * persona name. Throws if any soul file is missing — the build's
 * `copy-assets` step is responsible for ensuring all nine are present, so a
 * missing file at this point indicates a broken package, not a runtime
 * config problem.
 *
 * Reads run in parallel; the Record is returned as a frozen object so
 * callers can't accidentally mutate the bundled defaults.
 */
export async function loadBundledSouls(): Promise<Readonly<Record<BuiltinPersona, string>>> {
  const entries = await Promise.all(
    BUILTIN_PERSONAS.map(async (persona) => {
      const path = join(SOULS_DIR, `${persona}.md`);
      try {
        const text = await readFile(path, 'utf8');
        return [persona, text] as const;
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Bundled soul file missing for persona "${persona}" at ${path}. ` +
            `This indicates a broken @agenti-fy/setup package — the build's ` +
            `copy-assets step should have copied all nine souls into dist/souls/. ` +
            `Original error: ${cause}`,
        );
      }
    }),
  );
  return Object.freeze(Object.fromEntries(entries) as Record<BuiltinPersona, string>);
}

/**
 * Read the bundled `prometheus.yml` (the default Prometheus scrape config
 * shipped with the in-tree compose). The wizard writes this alongside the
 * generated `docker-compose.yml` so `docker compose --profile monitoring up`
 * works without an extra config step.
 *
 * Same provenance as loadBundledSouls: copy-assets at build time copies
 * `<repo-root>/prometheus.yml` into `dist/prometheus.yml`. A missing file
 * here indicates a broken package, not a runtime config problem — surfaces
 * as a thrown error with diagnostic context.
 */
const PROMETHEUS_YAML_PATH = join(__dirname, 'prometheus.yml');

export async function loadBundledPrometheusYaml(): Promise<string> {
  try {
    return await readFile(PROMETHEUS_YAML_PATH, 'utf8');
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Bundled prometheus.yml missing at ${PROMETHEUS_YAML_PATH}. This indicates a ` +
        `broken @agenti-fy/setup package — the build's copy-assets step should ` +
        `have copied <repo-root>/prometheus.yml into dist/prometheus.yml. ` +
        `Original error: ${cause}`,
    );
  }
}
