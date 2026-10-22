// Manual check (needs a signed-in `codex`): start/kill Codex threads through the REAL
// CodexStructuredSessionManager and count the shared app-server's descendant processes (each
// live thread's MCP tool set). Run from packages/core:  node --import tsx ../../scripts/codex-release-probe.mjs [cycles] [mode]
//   mode "fixed" (default): app-server argv from providers/codex.ts (unsubscribe + unload delay)
//   mode "legacy": plain `codex app-server`, no release (reproduces the leak by skipping the call)
import { execSync } from 'node:child_process';
import { CodexStructuredSessionManager } from '../packages/core/src/structured/codex-manager.ts';
import { codexProvider } from '../packages/core/src/providers/codex.ts';

const cycles = Number(process.argv[2] || 4);
const mode = process.argv[3] || 'fixed';
const { command, args } = codexProvider.buildStructuredCommand({});
const m = new CodexStructuredSessionManager();
if (mode === 'legacy') m.releaseThread = () => {}; // private method: neutralise the release
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pid = -1;
const descendants = () => {
  const rows = execSync('ps -axo pid=,ppid=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map(); for (const [p, pp] of rows) (kids.get(pp) ?? kids.set(pp, []).get(pp)).push(p);
  let n = 0; const walk = (x) => { for (const k of kids.get(x) ?? []) { n++; walk(k); } }; walk(pid); return n;
};
const spawnOne = (id) => { pid = m.spawn(id, { command, args: mode === 'legacy' ? ['app-server'] : args, workDir: '/tmp', escalate: true }); };
spawnOne('anchor'); // a thread that stays live, so the shared child never closes (the daemon's real situation)
await sleep(8000);
console.log(`mode=${mode} baseline (1 live thread): ${descendants()} descendants`);
for (let i = 1; i <= cycles; i++) {
  spawnOne(`t${i}`);
  await sleep(8000);
  const live = descendants();
  m.kill(`t${i}`);
  await sleep(mode === 'legacy' ? 15000 : 16000);
  console.log(`cycle ${i}: while live ${live}, 16 s after kill ${descendants()}`);
}
m.killAll();
