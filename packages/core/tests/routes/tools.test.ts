import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { createToolsRouter } from '../../src/routes/tools.js';
import { ToolAuthProber, type AuthCheckRunner } from '../../src/tools/auth-probe.js';
import { toolPaths } from '../../src/tools/paths.js';

let toolsDir: string; let app: any;
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-rt-'));
  toolsDir = path.join(root, 'tools');
  const db = new Database(':memory:'); initSchema(db);
  app = createApp({ db, skipPty: true, toolsDir });
});
afterEach(() => fs.rmSync(path.dirname(toolsDir), { recursive: true, force: true }));

it('GET /api/tools returns the manifest with status', async () => {
  const res = await request(app).get('/api/tools');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.tools)).toBe(true);
  const jq = res.body.tools.find((t: any) => t.name === 'jq');
  expect(jq).toBeTruthy();
  expect(jq).toHaveProperty('installed');
  expect(jq).toHaveProperty('authed');
  expect(res.body).toHaveProperty('checkedAt');
});

describe('GET /api/tools with an auth prober', () => {
  // A router-level app so the prober's runner can be injected — no real CLI ever runs.
  let sandbox: string; let base: string; let rapp: express.Express; let prober: ToolAuthProber;
  let run: ReturnType<typeof vi.fn<AuthCheckRunner>>;
  const fakecli = (body: request.Response) => body.body.tools.find((t: any) => t.name === 'fakecli');
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-rp-'));
    const root = path.join(sandbox, 'work'); // work in a subdir; only the sandbox is deleted
    fs.mkdirSync(root);
    base = path.join(root, 'tools');
    fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
      { name: 'fakecli', description: 'Fake CLI', kind: 'binary', bins: ['fakecli'], authEnv: ['FAKECLI_TOKEN'], authCheck: { args: ['whoami'] } },
    ] }));
    fs.mkdirSync(toolPaths(base).bin, { recursive: true });
    fs.writeFileSync(path.join(toolPaths(base).bin, 'fakecli'), '#!/bin/sh\n'); fs.chmodSync(path.join(toolPaths(base).bin, 'fakecli'), 0o755);
    run = vi.fn<AuthCheckRunner>(async () => 'ok');
    prober = new ToolAuthProber({ base, env: {}, run });
    rapp = express().use('/api/tools', createToolsRouter({ base, prober }));
  });
  afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  it('awaits a refresh when the cache is stale, then serves the cache', async () => {
    const first = await request(rapp).get('/api/tools');
    expect(run).toHaveBeenCalledTimes(1);
    expect(fakecli(first).authed).toBe(true);
    expect(typeof first.body.checkedAt).toBe('string');
    const second = await request(rapp).get('/api/tools');
    expect(run).toHaveBeenCalledTimes(1);
    expect(second.body.checkedAt).toBe(first.body.checkedAt);
  });

  it('?refresh=1 re-runs the checks even when the cache is fresh', async () => {
    await request(rapp).get('/api/tools');
    run.mockImplementation(async () => 'failed');
    const res = await request(rapp).get('/api/tools?refresh=1');
    expect(run).toHaveBeenCalledTimes(2);
    expect(fakecli(res).authed).toBe(false);
    expect(typeof res.body.checkedAt).toBe('string');
  });

  it('a change in the thread env makes the next load re-run the checks', async () => {
    await request(rapp).get('/api/tools');
    await request(rapp).get('/api/tools');
    expect(run).toHaveBeenCalledTimes(1);
    prober.setSpawnEnv({ FAKECLI_TOKEN: 'fake-token' }); // e.g. saved in Settings → Secrets
    await request(rapp).get('/api/tools');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('serves authState: a failed check wins over the auth env; an unknown one falls back to the thread env', async () => {
    const state = async (url: string) => { const t = fakecli(await request(rapp).get(url)); return [t.authState, t.authed]; };
    prober.setSpawnEnv({ FAKECLI_TOKEN: 'expired-token' });
    run.mockImplementation(async () => 'failed');
    expect(await state('/api/tools')).toEqual(['needed', false]);
    run.mockImplementation(async () => 'unknown');
    expect(await state('/api/tools?refresh=1')).toEqual(['ok', true]);
    prober.setSpawnEnv({}); // judged against the thread env, not the daemon's
    expect(await state('/api/tools')).toEqual(['unknown', false]);
  });
});
