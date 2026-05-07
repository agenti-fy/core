#!/usr/bin/env node
import { readPackageVersion } from '@agentify/shared';

// dist/bin.js → .. → setup package root
const VERSION = readPackageVersion(import.meta.url, 1);

console.log(`agentify-setup ${VERSION} — coming soon`);
process.exit(0);
