#!/usr/bin/env node
// Writes its own environment to the file named by argv[2] (or DUMP_ENV_FILE), then waits to be stopped.
// For tests/security/child-env.test.ts: what a process the daemon starts can see.
import fs from 'node:fs';
const out = process.argv.find((a) => a.endsWith('.env.json')) ?? process.env.DUMP_ENV_FILE;
if (out) fs.writeFileSync(out, JSON.stringify(process.env));
process.stdin.resume();
setTimeout(() => process.exit(0), 5000);
