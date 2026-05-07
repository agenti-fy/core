#!/usr/bin/env node
/**
 * bin.ts — agentify-setup entry point.
 *
 * Parses argv via cli.ts, short-circuits for --help / --version, then
 * dispatches to runCli().  The real wizard orchestration (run()) lands in
 * a follow-up issue; for now runCli() logs the parsed args and exits 0.
 */
import { readPackageVersion } from '@agentify/shared';
import { parseArgs, CliError, type CliArgs } from './cli.js';

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
      `  --prefix <s>           Name prefix for the nine GitHub Apps (e.g. "myorg")\n` +
      `  --repo <owner/name>    Target repository (e.g. "acme/my-project")\n` +
      `  --dry-run              Print the generated .env to stdout; do not write to disk\n` +
      `  --state-file <path>    Override the default state file location\n` +
      `  -V, --version          Print version and exit\n` +
      `  -h, --help             Show this help\n` +
      `\n` +
      `Subcommands and flags may be combined:\n` +
      `  agentify-setup init --prefix myorg --repo acme/my-project\n` +
      `  agentify-setup resume --state-file /tmp/setup.json\n` +
      `  agentify-setup verify --dry-run\n` +
      `\n` +
      `  🎯 The Orchestrator · agentify-setup wizard\n`,
  );
}

// ── runCli ────────────────────────────────────────────────────────────────────

/**
 * Thin dispatcher.  The real wizard logic (run()) lands in a follow-up task.
 * For now, pretty-print the parsed arguments so the caller can verify wiring.
 */
async function runCli(args: CliArgs): Promise<void> {
  process.stdout.write(JSON.stringify(args, null, 2) + '\n');
}

// ── Entry ─────────────────────────────────────────────────────────────────────

let parsed: CliArgs;
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

await runCli(parsed);
process.exit(0);
