import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as appState from '../db/app-state.js';
import { createStateRouter } from './state.js';
import { getRunningVersion } from '../update/version.js';

let dir: string;
let db: Database.Database;

function app() {
  const a = express();
  a.use('/api/state', createStateRouter(db));
  return a;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-state-'));
  db = createDatabase(path.join(dir, 'test.db'));
});
afterEach(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('GET /api/state/update', () => {
  it('reports no update available when nothing has been checked yet', async () => {
    const res = await request(app()).get('/api/state/update');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: false,
      version: null,
      url: null,
      publishedAt: null,
      currentVersion: getRunningVersion(),
    });
  });

  it('surfaces a persisted newer release for a late-joining client', async () => {
    appState.set(db, 'latest_release_tag', 'v999.0.0');
    appState.set(db, 'latest_release_url', 'https://example.com/v999.0.0');
    appState.set(db, 'latest_release_published_at', '2026-01-01T00:00:00Z');

    const res = await request(app()).get('/api/state/update');
    expect(res.body).toEqual({
      available: true,
      version: 'v999.0.0',
      url: 'https://example.com/v999.0.0',
      publishedAt: '2026-01-01T00:00:00Z',
      currentVersion: getRunningVersion(),
    });
  });

  it('does not report a stale "available" once the persisted tag is no longer newer than the running version', async () => {
    // Simulates state left over from before this daemon updated to that very release.
    appState.set(db, 'latest_release_tag', getRunningVersion());
    appState.set(db, 'latest_release_url', 'https://example.com/current');

    const res = await request(app()).get('/api/state/update');
    expect(res.body.available).toBe(false);
    expect(res.body.version).toBeNull();
  });
});
