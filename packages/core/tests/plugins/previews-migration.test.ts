import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as pluginData from '../../src/db/plugin-data.js';
import { migratePreviews, MIGRATE_MAX } from '../../src/plugins/previews-migration.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { KeysManager } from '../routes/keys-manager.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Old previews rows move into the Previews plugin's storage once (plugins slice 4). */
describe('the previews migration', () => {
  let db: Database.Database; let tmp: string; let proj: string;
  const row = (id: string, files: unknown[], seen: string | null = null) => db.prepare(
    'INSERT INTO previews (id, session_id, session_name, terminal_id, terminal_label, title, note, text, files, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'A', 'Alpha', 'tA', 'Worker A', `Title ${id}`, 'a note', id === 'p1' ? 'copy me' : null, JSON.stringify(files), `2026-11-0${id.slice(1)}T10:00:00.000Z`, seen);
  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-migr-'));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-migr-proj-'));
    fs.writeFileSync(path.join(proj, 'shot.png'), Buffer.from([1, 2, 3]));
    db = new Database(':memory:'); initSchema(db);
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: proj });
    row('p1', [{ path: path.join(proj, 'shot.png'), name: 'shot.png', mime: 'image/png', size: 3 }]);
    row('p2', [], '2026-11-03T11:00:00.000Z');
  });
  afterEach(() => { for (const d of [tmp, proj]) fs.rmSync(d, { recursive: true, force: true }); });

  it('migrated rows carry file ids that serve, keep their seen state, and the migration runs once', async () => {
    expect(migratePreviews(db)).toBe(2);
    const docs = pluginData.listDocs(db, 'previews', { values: true });
    expect(docs.map((d) => d.key)).toEqual(['preview:p1', 'preview:p2']);
    const p1 = docs[0].value as { files: { fileId: string; name: string; mime: string; size: number }[]; text: string; seenAt: string | null; sessionName: string; terminalLabel: string; createdAt: string };
    expect(p1).toMatchObject({ text: 'copy me', seenAt: null, sessionName: 'Alpha', terminalLabel: 'Worker A', createdAt: '2026-11-01T10:00:00.000Z' });
    expect(p1.files.map((f) => [f.name, f.mime, f.size])).toEqual([['shot.png', 'image/png', 3]]);
    expect((docs[1].value as { seenAt: string }).seenAt).toBe('2026-11-03T11:00:00.000Z');
    const mgr = new KeysManager();
    const app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), bundledDir: path.join(REPO, 'packages/plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    const served = await request(app).get(`/api/plugins/previews/files/${p1.files[0].fileId}`);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/^image\/png/);
    // A second run (and a daemon start, which runs it) copies nothing more, even for a row added later.
    row('p3', []);
    expect(migratePreviews(db)).toBe(0);
    expect(pluginData.listDocs(db, 'previews')).toHaveLength(2);
    expect((pluginData.getSettings(db, 'previews')?.value as { migrated: boolean }).migrated).toBe(true);
  });

  it('the newest rows win the cap; a files entry missing a field and a bad files JSON are skipped, not fatal', () => {
    const ins = db.prepare('INSERT INTO previews (id, session_id, session_name, terminal_id, terminal_label, title, note, text, files, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < MIGRATE_MAX + 100; i++) ins.run(`r${i}`, 'A', 'Alpha', null, null, `T${i}`, null, null, '[]', new Date(Date.UTC(2027, 0, 1, 0, i)).toISOString(), null);
    ins.run('bad1', 'A', 'Alpha', null, null, 'Bad files', null, 'kept', JSON.stringify([{ path: path.join(proj, 'shot.png') }]), '2028-01-01T00:00:00.000Z', null);
    ins.run('bad2', 'A', 'Alpha', null, null, 'Bad json', null, 'kept too', 'not json', '2028-01-02T00:00:00.000Z', null);
    expect(migratePreviews(db)).toBe(MIGRATE_MAX);
    const keys = new Set(pluginData.listDocs(db, 'previews').map((d) => d.key));
    expect(keys.size).toBe(MIGRATE_MAX);
    expect(keys.has('preview:bad1')).toBe(true);
    expect(keys.has('preview:bad2')).toBe(true);
    expect(keys.has(`preview:r${MIGRATE_MAX + 99}`)).toBe(true);
    expect(keys.has('preview:r0')).toBe(false);
    expect((pluginData.getDoc(db, 'previews', 'preview:bad1')!.value as { files: unknown[] }).files).toEqual([]);
    // p1 (2026) and the incomplete entry of bad1 are outside the newest rows or skipped: no file reference at all.
    expect(db.prepare('SELECT COUNT(*) AS n FROM plugin_files').get()).toEqual({ n: 0 });
  });

  it('an install without the old table, or with none to copy, is left alone', () => {
    const fresh = new Database(':memory:'); initSchema(fresh);
    expect(migratePreviews(fresh)).toBe(0);
    expect(pluginData.getSettings(fresh, 'previews')?.value).toMatchObject({ migrated: true });
  });
});
