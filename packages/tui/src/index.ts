#!/usr/bin/env node
import { render } from 'ink';
import React from 'react';
import { readPackageVersion } from '@agentify/shared';
import { App } from './App.js';
import { CoordinatorApi } from './api.js';
import { renderText, snapshot } from './status.js';

type Subcommand = 'tui' | 'status';

interface CliArgs {
  subcommand: Subcommand;
  coordinatorUrl: string;
  pollIntervalMs: number;
  json: boolean;
  showHelp: boolean;
  showVersion: boolean;
}

// dist/index.js → .. → tui package root
const VERSION = readPackageVersion(import.meta.url, 1);

function normalizeUrl(s: string): string {
  return s.replace(/\/+$/, '');
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    subcommand: 'tui',
    coordinatorUrl: normalizeUrl(process.env['COORDINATOR_URL'] ?? 'http://localhost:8080'),
    pollIntervalMs: 1000,
    json: false,
    showHelp: false,
    showVersion: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '-h' || a === '--help') args.showHelp = true;
    else if (a === '-V' || a === '--version') args.showVersion = true;
    else if (a === '--coordinator' || a === '-c') {
      const next = argv[++i];
      if (next !== undefined) args.coordinatorUrl = normalizeUrl(next);
    } else if (a === '--poll' || a === '-p') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.pollIntervalMs = n;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === 'tui' || a === 'status') {
      args.subcommand = a;
    } else if (a.startsWith('-')) {
      // unknown flag — ignore (tolerant)
    }
  }
  return args;
}

function help(): void {
   
  console.log(
    `agentify ${VERSION} — coordinator dashboard + one-shot status snapshot\n\n` +
      `Usage:\n` +
      `  agentify [tui]                     Open the live dashboard (default)\n` +
      `  agentify status [--json]           Print a one-shot snapshot and exit\n\n` +
      `Options:\n` +
      `  -c, --coordinator URL              Coordinator base URL (default: $COORDINATOR_URL or http://localhost:8080)\n` +
      `  -p, --poll MS                      TUI poll interval in ms (default: 1000)\n` +
      `      --json                         status: emit JSON instead of text\n` +
      `  -V, --version                      Print version and exit\n` +
      `  -h, --help                         Show this help\n\n` +
      `Keybindings (in TUI):\n` +
      `  d / a / j / r / l                  Dashboard / Agents / Jobs / Repos / Logs\n` +
      `  h                                  Halt or resume (toggle, with confirmation)\n` +
      `  R                                  Reset selected agent (Agents screen)\n` +
      `  1-5                                Set log min level (Logs screen)\n` +
      `  q                                  Quit\n`,
  );
}

async function runStatus(coordinatorUrl: string, json: boolean): Promise<number> {
  try {
    const snap = await snapshot(coordinatorUrl);
     
    if (json) console.log(JSON.stringify(snap, null, 2));
    else process.stdout.write(renderText(snap));
    return 0;
  } catch (err) {
     
    console.error(`status failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runTui(coordinatorUrl: string, pollIntervalMs: number): Promise<number> {
  const api = new CoordinatorApi(coordinatorUrl);
  const { waitUntilExit } = render(
    React.createElement(App, { api, baseUrl: coordinatorUrl, pollIntervalMs }),
  );
  try {
    await waitUntilExit();
    return 0;
  } catch (err) {
     
    console.error(err);
    return 1;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.showHelp) {
  help();
  process.exit(0);
}
if (args.showVersion) {
   
  console.log(VERSION);
  process.exit(0);
}

const exitCode =
  args.subcommand === 'status'
    ? await runStatus(args.coordinatorUrl, args.json)
    : await runTui(args.coordinatorUrl, args.pollIntervalMs);
process.exit(exitCode);
