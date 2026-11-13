// Final review N3: the subagent history finds its meta file in ONE agent-side process (not one per file).
// Both paths (in process; and the agent script that runs under privilege separation) skip a link, a FIFO
// and an oversize file, and 600 files take one short search.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentFindMeta } from '../../src/privsep/agent-fs.js';

function folder(): { dir: string; names: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-meta-'));
  const names: string[] = [];
  for (let i = 0; i < 600; i++) { const n = `agent-a${i}.meta.json`; fs.writeFileSync(path.join(dir, n), JSON.stringify({ toolUseId: `other-${i}` })); names.push(n); }
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'find-meta-out-')), 'secret.json');
  fs.writeFileSync(outside, JSON.stringify({ toolUseId: 'call-1' }));
  fs.symlinkSync(outside, path.join(dir, 'agent-link.meta.json'));
  execFileSync('mkfifo', [path.join(dir, 'agent-fifo.meta.json')]);
  fs.writeFileSync(path.join(dir, 'agent-big.meta.json'), JSON.stringify({ toolUseId: 'call-1', pad: 'x'.repeat(70_000) }));
  fs.writeFileSync(path.join(dir, 'agent-real.meta.json'), JSON.stringify({ toolUseId: 'call-1' }));
  return { dir, names: ['agent-link.meta.json', 'agent-fifo.meta.json', 'agent-big.meta.json', ...names, 'agent-real.meta.json'] };
}

describe('agentFindMeta', () => {
  for (const mode of ['in process', 'one agent process'] as const) {
    it(`${mode}: finds the real file past a link, a FIFO, an oversize file and 600 others`, async () => {
      const { dir, names } = folder();
      const cfg = mode === 'in process' ? null : ({} as never);
      const t0 = Date.now();
      expect(await agentFindMeta(dir, names, 64 * 1024, 'call-1', cfg)).toBe('agent-real.meta.json');
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(await agentFindMeta(dir, names, 64 * 1024, 'nobody', cfg)).toBeNull();
    });
  }
});
