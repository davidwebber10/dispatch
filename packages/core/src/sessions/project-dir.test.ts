import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, hostedProjectDir, safeFolderName } from './project-dir.js';

describe('project folders', () => {
  test('~ is expanded', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/a/b', '/h')).toBe('/h/a/b');
    expect(expandHome('/x/~/y', '/h')).toBe('/x/~/y');
    expect(expandHome('~other', '/h')).toBe('~other');
  });
  test('a hosted project from a name: ~/projects/<safe>, created and de-duplicated', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'projdir-'));
    const a = hostedProjectDir('Q3 Sales: report!', home);
    expect(a).toBe(path.join(home, 'projects', 'Q3-Sales-report'));
    expect(fs.statSync(a).isDirectory()).toBe(true);
    expect(hostedProjectDir('Q3 Sales: report!', home)).toBe(path.join(home, 'projects', 'Q3-Sales-report-2'));
    expect(safeFolderName('../..')).toBe('project');
    expect(safeFolderName('')).toBe('project');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('tool detection on a hosted box (#12)', () => {
  test('a tool on PATH counts as installed only when hosted', async () => {
    const { toolStatuses, onPath } = await import('../tools/status.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgbin-'));
    fs.writeFileSync(path.join(dir, 'rg'), '#!/bin/sh\n', { mode: 0o755 });
    expect(onPath('rg', dir)).toBe(true);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));
    const saved = { ...process.env };
    try {
      delete process.env.OS_BASE_URL; delete process.env.OS_BOX_TOKEN;
      const local = toolStatuses({ base, env: { PATH: dir } }).find((t) => t.name === 'ripgrep');
      process.env.OS_BASE_URL = 'http://os'; process.env.OS_BOX_TOKEN = 't';
      const hosted = toolStatuses({ base, env: { PATH: dir } }).find((t) => t.name === 'ripgrep');
      if (local && hosted) { expect(local.installed).toBe(false); expect(hosted.installed).toBe(true); }
    } finally { process.env = saved; }
  });
});
