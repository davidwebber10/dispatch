import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/connection.js';
import { createSetupRouter } from '../../src/routes/setup.js';
import type { ShellRunner } from '../../src/setup/install.js';

let dir: string;
let home: string;
let realHome: string | undefined;
let db: Database.Database;

const secrets = { status: () => ({ connected: false }) } as never;

function app(run?: ShellRunner) {
  const a = express();
  a.use(express.json());
  a.use('/api/setup', createSetupRouter(db, secrets, run));
  return a;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-setup-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-home-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
  db = createDatabase(path.join(dir, 'test.db'));
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

describe('POST /api/setup/install/:provider', () => {
  it('runs the install and returns the re-detected status', async () => {
    const run: ShellRunner = vi.fn(async () => {
      const bin = path.join(home, '.grok', 'bin', 'grok');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '#!/bin/sh\necho 1.0.3\n', { mode: 0o755 });
      fs.chmodSync(bin, 0o755);
      return { ok: true, output: 'Grok 1.0.3 installed' };
    });

    const res = await request(app(run)).post('/api/setup/install/grok');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status.installed).toBe(true);
    expect(res.body.loginCommand).toBe('grok login');
    expect(run).toHaveBeenCalledWith('curl -fsSL https://x.ai/cli/install.sh | bash');
  });

  it('rejects an unknown provider before anything reaches a shell', async () => {
    const run: ShellRunner = vi.fn(async () => ({ ok: true, output: '' }));

    const res = await request(app(run)).post('/api/setup/install/' + encodeURIComponent('grok; rm -rf /'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown provider/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a failed install with its output rather than a 500', async () => {
    const run: ShellRunner = vi.fn(async () => ({ ok: false, output: 'npm ERR! EACCES' }));

    const res = await request(app(run)).post('/api/setup/install/codex');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.output).toContain('EACCES');
    // `status.installed` is deliberately NOT asserted: detection consults the real PATH,
    // and a developer running this suite may genuinely have codex installed. The contract
    // under test is that a failed installer yields ok:false with its log, not a 500.
  });

  it('surfaces a thrown runner as a 500 rather than hanging the request', async () => {
    const run: ShellRunner = vi.fn(async () => { throw new Error('spawn failed'); });

    const res = await request(app(run)).post('/api/setup/install/claude');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('spawn failed');
  });
});

describe('GET /api/setup/state', () => {
  it('reports all three agent CLIs, so the modal can grey out what is missing', async () => {
    const res = await request(app()).get('/api/setup/state');
    expect(res.status).toBe(200);
    expect(res.body.providers.map((p: { name: string }) => p.name)).toEqual(['claude', 'codex', 'grok']);
  });
});
