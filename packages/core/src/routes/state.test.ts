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
import { readLocalReleaseNote } from '../update/notes.js';

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
      notes: [],
      currentNotes: readLocalReleaseNote(getRunningVersion()),
    });
  });

  it('surfaces a persisted newer release for a late-joining client', async () => {
    appState.set(db, 'latest_release_tag', 'v999.0.0');
    appState.set(db, 'latest_release_url', 'https://example.com/v999.0.0');
    appState.set(db, 'latest_release_published_at', '2026-01-01T00:00:00Z');

    const res = await request(app()).get('/api/state/update');
    expect(res.body).toMatchObject({
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

  it('returns the release notes for every version between the running one and the newest', async () => {
    appState.set(db, 'latest_release_tag', 'v999.1.0');
    appState.set(db, 'latest_release_notes', JSON.stringify([
      { version: 'v999.1.0', url: 'u', publishedAt: 'p', notes: '# 999.1.0\n\nSecond.' },
      { version: 'v999.0.0', url: 'u', publishedAt: 'p', notes: '# 999.0.0\n\nFirst.' },
    ]));

    const res = await request(app()).get('/api/state/update');
    expect(res.body.notes.map((n: { version: string }) => n.version)).toEqual(['v999.1.0', 'v999.0.0']);
    expect(res.body.notes[0].notes).toContain('Second.');
  });

  it('withholds notes for a version this daemon already runs', async () => {
    // The same stale-state case as above: the cache is never a trusted flag.
    appState.set(db, 'latest_release_tag', getRunningVersion());
    appState.set(db, 'latest_release_notes', JSON.stringify([
      { version: getRunningVersion(), url: 'u', publishedAt: 'p', notes: 'already installed' },
    ]));

    const res = await request(app()).get('/api/state/update');
    expect(res.body.notes).toEqual([]);
  });

  it('returns the note for the running version so Settings can show "what is new"', async () => {
    const res = await request(app()).get('/api/state/update');
    // This checkout ships docs/releases/v<current>.md, so the note resolves from disk.
    expect(res.body.currentNotes).toBe(readLocalReleaseNote(getRunningVersion()));
    expect(res.body.currentNotes).toContain('Dispatch');
  });
});

// session-stats reads ~/.claude/projects/<any-dir>/<sessionId>.jsonl, so we point
// HOME at a temp dir for these tests (same pattern as tests/sessions/kickstart.test.ts).
describe('GET /api/state/session-stats/:sessionId', () => {
  const realHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-state-home-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeTranscript(sessionId: string, model: string): void {
    const projDir = path.join(home, '.claude', 'projects', 'test-project');
    fs.mkdirSync(projDir, { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        model,
        usage: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), line);
  }

  // Regression: notionalValueUsd() returning null for an unpriced model must not be
  // coerced to 0 at this route boundary — that would silently claim the session cost
  // nothing when the truth is we simply don't know its price.
  it('reports estimatedCostUSD as null, not 0, for a model with no price entry', async () => {
    writeTranscript('unpriced-session', 'some-future-model');

    const res = await request(app()).get('/api/state/session-stats/unpriced-session');

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.estimatedCostUSD).toBeNull();
  });
});
