import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Read `version` from a package.json relative to a calling module's URL.
 * The caller passes `import.meta.url` and an offset of `..` segments to walk
 * up from `dist/...` to the package root where package.json lives.
 *
 *   readPackageVersion(import.meta.url, 2)  // dist/routes/x.js → ../.. → package root
 */
export function readPackageVersion(callerUrl: string, levelsUp: number): string {
  try {
    const callerDir = dirname(fileURLToPath(callerUrl));
    const upSegments = Array<string>(levelsUp).fill('..');
    const pkgPath = join(callerDir, ...upSegments, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
