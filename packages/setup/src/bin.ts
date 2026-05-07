#!/usr/bin/env node
/**
 * bin.ts — agentify-setup entry point.
 *
 * Parses argv via cli.ts, short-circuits for --help / --version, then
 * dispatches to run() (the wizard orchestrator).
 */
import { readPackageVersion } from '@agentify/shared';
import { parseArgs, CliError } from './cli.js';
import { run } from './index.js';

// dist/bin.js → .. → setup package root
const VERSION = readPackageVersion(import.meta.url, 1);

// ── Help text ─────────────────────────────────────────────────────────────────

function printHelp(): void {
  process.stdout.write(
    `agentify-setup ${VERSION} — interactive wizard to bootstrap GitHub Apps and .env\n` +
      `\n` +
      `Usage:\n` +
      `  agentify-setup [init]                  Run the full setup wizard (default)\n` +
      `  agentify-setup resume                  Resume a previously interrupted session\n` +
      `  agentify-setup verify                  Verify existing .env and App installations\n` +
      `\n` +
      `Options:\n` +
      `  --prefix <s>           Name prefix for the ten GitHub Apps (e.g. "myorg")\n` +
      `  --repo <owner/name>    Target repository (e.g. "acme/my-project")\n` +
      `  --dry-run              Print the generated .env to stdout; do not write to disk\n` +
      `  --env-out <path>       Write the generated .env to <path> (default: <cwd>/.env)\n` +
      `  --state-file <path>    Override the default state file location\n` +
      `  -V, --version          Print version and exit\n` +
      `  -h, --help             Show this help\n` +
      `\n` +
      `Subcommands and flags may be combined:\n` +
      `  agentify-setup init --prefix myorg --repo acme/my-project\n` +
      `  agentify-setup resume --state-file /tmp/setup.json\n` +
      `  agentify-setup verify --env-out /etc/agentify/.env\n` +
      `\n` +
      `  🎯 The Orchestrator · agentify-setup wizard\n`,
  );
}

// ── Entry ─────────────────────────────────────────────────────────────────────

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliError) {
    process.stderr.write(`agentify-setup: ${err.message}\n`);
    process.exit(err.exitCode);
  }
  throw err;
}

if (parsed.showHelp) {
  printHelp();
  process.exit(0);
}

if (parsed.showVersion) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const exitCode = await run(parsed);
process.exit(exitCode);
