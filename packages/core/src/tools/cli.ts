// packages/core/src/tools/cli.ts
import { loadManifest } from './manifest.js';
import { installTool, uninstallTool } from './installer.js';
import { toolStatuses } from './status.js';

export async function runToolsCli(argv: string[], opts?: { base?: string }): Promise<number> {
  const [cmd, name] = argv;
  const base = opts?.base;
  if (cmd === 'list' || cmd === 'status') {
    for (const s of toolStatuses({ base })) {
      console.log(`${s.installed ? '✓' : ' '} ${s.name.padEnd(14)} ${s.authed ? 'authed ' : 'no-auth'} ${s.kind}  ${s.description}`);
    }
    return 0;
  }
  if (cmd === 'install') {
    const manifest = loadManifest(base);
    const targets = name ? manifest.filter((e) => e.name === name) : manifest;
    if (name && !targets.length) { console.error(`no such tool: ${name}`); return 1; }
    let failed = 0;
    for (const e of targets) {
      try { console.log(`installing ${e.name}…`); await installTool(e, { base }); }
      catch (err) { failed++; console.error(`  ${e.name} failed: ${(err as Error).message}`); }
    }
    return failed ? 1 : 0;
  }
  if (cmd === 'uninstall') {
    if (!name) { console.error('usage: tools uninstall <name>'); return 1; }
    try { uninstallTool(name, base); return 0; }
    catch (e) { console.error(String((e as Error).message ?? e)); return 1; }
  }
  console.error('usage: dispatch tools <install|list|uninstall> [name]');
  return 1;
}

// Run directly: `node dist/tools/cli.js <args>`
const isMain = process.argv[1] && process.argv[1].endsWith('tools/cli.js');
if (isMain) { runToolsCli(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); }); }
