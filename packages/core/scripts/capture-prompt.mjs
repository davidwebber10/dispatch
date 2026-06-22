#!/usr/bin/env node
// Usage: node capture-prompt.mjs "<command>" <secondsToRun> > fixture.txt
// Spawns the command in a PTY, echoes everything it emits to stdout, and exits
// after N seconds (or on exit). Pipe stdout to a fixture file, then trigger the
// prompt interactively in another pane if needed. Captures raw ANSI verbatim.
import pty from 'node-pty';

const [, , command, secs = '8'] = process.argv;
if (!command) { process.stderr.write('usage: capture-prompt.mjs "<command>" <secs>\n'); process.exit(2); }

const proc = pty.spawn('/bin/zsh', ['-ilc', command], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
  env: process.env,
});

proc.onData((d) => process.stdout.write(d));
const timer = setTimeout(() => { try { proc.kill(); } catch {} process.exit(0); }, Number(secs) * 1000);
proc.onExit(() => { clearTimeout(timer); process.exit(0); });
