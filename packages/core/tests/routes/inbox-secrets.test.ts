import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { SecretsService } from '../../src/secrets/service.js';
import { configureInboxSecretClock, SECRET_TTL_MS } from '../../src/inbox/secret-store.js';
import { isSecretPath } from '../../src/files/secret-paths.js';
import { KeysManager } from './keys-manager.js';

/**
 * "Send a secret" through the Inbox (2026-11-12). The owner stores a secret and gets a 6-character ID; a thread
 * in the scope uses the ID once, and the DAEMON writes the value to a file of the project or to Doppler. The
 * value never comes back to the thread (except `reveal`, when the owner allowed it), and never to a list.
 */
const VALUE = 'sk_live_TOPSECRET_9f8e7d';

describe('inbox secrets routes', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  let proj: string;
  let projB: string;
  let outside: string;
  let client: { setSecret: ReturnType<typeof vi.fn>; [k: string]: unknown };
  let now: number;
  let logs: string[];

  const key = (terminalId: string) => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId }).key}` });
  const create = (body: Record<string, unknown>) => request(app).post('/api/inbox/secrets').send(body);
  const use = (terminalId: string, body: Record<string, unknown>) => request(app).post('/api/inbox/secrets/use').set(key(terminalId)).send(body);
  const valueDir = () => path.join(tmp, 'inbox-secrets');

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-secrets-')));
    proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-secrets-proj-')));
    projB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-secrets-projb-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-secrets-out-')));
    now = Date.parse('2026-11-12T10:00:00Z');
    configureInboxSecretClock(() => now);
    client = {
      verify: vi.fn(async () => true), listProjects: vi.fn(async () => []), listConfigs: vi.fn(async () => []),
      listSecrets: vi.fn(async () => []), getSecret: vi.fn(async () => null), deleteSecret: vi.fn(async () => {}),
      setSecret: vi.fn(async () => {}),
    };
    fs.writeFileSync(path.join(tmp, 'doppler.json'), JSON.stringify({ token: 'dp.st.fake', project: 'web', config: 'dev', enabled: true, readOnly: false, tokenScope: 'opted-in' }), { mode: 0o600 });
    const secretsService = new SecretsService(tmp, () => client as never, path.join(tmp, 'no-mcp.js'));
    db = new Database(':memory:');
    initSchema(db);
    const mgr = new KeysManager();
    app = createApp({ db, skipPty: true, secretsDir: tmp, secretsService, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: proj });
    sessionsDb.create(db, { id: 'B', provider: 'claude-code', name: 'Beta', workingDir: projB });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'structured', role: 'agent' } });
    terminalsDb.create(db, { id: 'tA2', sessionId: 'A', type: 'claude-code', label: 'Other A', config: { transport: 'structured', role: 'agent' } });
    terminalsDb.create(db, { id: 'tB', sessionId: 'B', type: 'claude-code', label: 'Worker B', config: { transport: 'structured', role: 'agent' } });
    logs = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    configureInboxSecretClock();
    for (const d of [tmp, proj, projB, outside]) fs.rmSync(d, { recursive: true, force: true });
  });

  // ── the owner's routes ────────────────────────────────────────────────────────────────────
  describe('create, list, delete (owner)', () => {
    it('create answers a 6-character ID and never the value; list carries no value', async () => {
      const r = await create({ name: 'Stripe key', value: VALUE, sessionId: 'A' });
      expect(r.status).toBe(201);
      expect(r.body.id).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      expect(r.body).toMatchObject({ name: 'Stripe key', sessionId: 'A', terminalId: null, allowReveal: false, state: 'waiting' });
      expect(JSON.stringify(r.body)).not.toContain(VALUE);
      const l = await request(app).get('/api/inbox/secrets');
      expect(l.status).toBe(200);
      expect(l.body.secrets).toHaveLength(1);
      expect(JSON.stringify(l.body)).not.toContain(VALUE);
      expect(l.headers['cache-control']).toBe('no-store');
    });

    it('a thread scope takes the project from the thread; a project filter on the list', async () => {
      const r = await create({ name: 'k', value: VALUE, terminalId: 'tA', allowReveal: true });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ sessionId: 'A', terminalId: 'tA', terminalLabel: 'Worker A', allowReveal: true });
      await create({ name: 'k2', value: VALUE, sessionId: 'B' });
      expect((await request(app).get('/api/inbox/secrets?sessionId=B')).body.secrets.map((s: any) => s.name)).toEqual(['k2']);
    });

    it('refuses a missing name, a missing value, an unknown project or thread, a thread of another project', async () => {
      expect((await create({ value: VALUE, sessionId: 'A' })).status).toBe(400);
      expect((await create({ name: 'k', value: '', sessionId: 'A' })).status).toBe(400);
      expect((await create({ name: 'k', value: VALUE })).status).toBe(400);
      expect((await create({ name: 'k', value: VALUE, sessionId: 'nope' })).status).toBe(404);
      expect((await create({ name: 'k', value: VALUE, terminalId: 'nope' })).status).toBe(404);
      expect((await create({ name: 'k', value: VALUE, sessionId: 'B', terminalId: 'tA' })).status).toBe(400);
      expect((await create({ name: 'k', value: 'x'.repeat(70_000), sessionId: 'A' })).status).toBe(400);
      // No error message carries the value.
      const bad = await create({ name: 'k', value: VALUE, sessionId: 'nope' });
      expect(JSON.stringify(bad.body)).not.toContain(VALUE);
    });

    it('a thread key cannot create, list or delete', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A' });
      expect((await request(app).post('/api/inbox/secrets').set(key('tA')).send({ name: 'k', value: VALUE, sessionId: 'A' })).status).toBe(403);
      expect((await request(app).get('/api/inbox/secrets').set(key('tA'))).status).toBe(403);
      expect((await request(app).delete(`/api/inbox/secrets/${made.body.id}`).set(key('tA'))).status).toBe(403);
    });

    it('delete removes the record and the stored value', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A' });
      expect(fs.existsSync(path.join(valueDir(), made.body.id))).toBe(true);
      expect((await request(app).delete(`/api/inbox/secrets/${made.body.id}`)).status).toBe(204);
      expect(fs.existsSync(path.join(valueDir(), made.body.id))).toBe(false);
      expect((await request(app).get('/api/inbox/secrets')).body.secrets).toEqual([]);
      expect((await request(app).delete(`/api/inbox/secrets/${made.body.id}`)).status).toBe(404);
    });

    it('the value folder is on the credential deny-list of the file routes', () => {
      expect(isSecretPath(path.join(tmp, 'inbox-secrets', 'K7Q2M4'), { home: os.homedir(), dataDir: tmp })).toBe(true);
    });
  });

  // ── the thread's route ─────────────────────────────────────────────────────────────────────
  describe('use: a file of the project', () => {
    it('upserts NAME=value in .env.local, mode 0600; the answer has no value; the record is used and the value gone', async () => {
      fs.writeFileSync(path.join(proj, '.env.local'), 'A=1\nSTRIPE_KEY=old\n', { mode: 0o644 });
      const made = await create({ name: 'Stripe key', value: VALUE, sessionId: 'A' });
      const r = await use('tA', { id: made.body.id.toLowerCase(), file: { path: path.join(proj, '.env.local'), name: 'STRIPE_KEY' } });
      expect(r.status).toBe(200);
      expect(r.body.message).toMatch(/^Wrote STRIPE_KEY to \.env\.local \(0600\)\. The value was removed from the Inbox\./);
      expect(JSON.stringify(r.body)).not.toContain(VALUE);
      expect(fs.readFileSync(path.join(proj, '.env.local'), 'utf8')).toBe(`A=1\nSTRIPE_KEY=${VALUE}\n`);
      expect(fs.statSync(path.join(proj, '.env.local')).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(path.join(valueDir(), made.body.id))).toBe(false);
      const rec = (await request(app).get('/api/inbox/secrets')).body.secrets[0];
      expect(rec).toMatchObject({ state: 'used', usedBy: 'tA', usedByLabel: 'Worker A', usedTo: { kind: 'file', path: '.env.local', name: 'STRIPE_KEY' } });
      // One use only.
      const again = await use('tA', { id: made.body.id, file: { path: '.env.local', name: 'STRIPE_KEY' } });
      expect(again.status).toBe(410);
      expect(again.body.error).toMatch(/already used/);
    });

    it('without a name writes the raw value as the whole file, in a new folder of the project, mode 0600', async () => {
      const made = await create({ name: 'cert', value: VALUE, sessionId: 'A' });
      const r = await use('tA', { id: made.body.id, file: { path: 'certs/deep/key.pem' } });
      expect(r.status).toBe(200);
      expect(fs.readFileSync(path.join(proj, 'certs/deep/key.pem'), 'utf8')).toBe(VALUE);
      expect(fs.statSync(path.join(proj, 'certs/deep/key.pem')).mode & 0o777).toBe(0o600);
      expect(r.body.message).toMatch(/certs\/deep\/key\.pem/);
    });

    it('says when the file is not ignored by git, and says nothing when it is', async () => {
      execFileSync('git', ['init', '-q'], { cwd: proj });
      fs.writeFileSync(path.join(proj, '.gitignore'), '.env.local\n');
      const a = await create({ name: 'a', value: VALUE, sessionId: 'A' });
      const ignored = await use('tA', { id: a.body.id, file: { path: '.env.local', name: 'A' } });
      expect(ignored.status).toBe(200);
      expect(ignored.body.message).not.toMatch(/not ignored/);
      const b = await create({ name: 'b', value: VALUE, sessionId: 'A' });
      const plain = await use('tA', { id: b.body.id, file: { path: '.env', name: 'B' } });
      expect(plain.status).toBe(200);
      expect(plain.body.message).toMatch(/\.env is not ignored by git/);
      expect(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')).toBe('.env.local\n'); // never edited
    });

    it('refuses a path outside the project, a symlink escape, a .git path and a credential path; the secret stays unused', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A' });
      const id = made.body.id;
      const refused = async (file: Record<string, unknown>) => {
        const r = await use('tA', { id, file });
        expect(r.status, JSON.stringify(file)).toBe(403);
        expect(JSON.stringify(r.body)).not.toContain(VALUE);
        return r;
      };
      await refused({ path: path.join(outside, 'x.env') });
      await refused({ path: '../escape.env' });
      fs.symlinkSync(outside, path.join(proj, 'linkdir'));
      await refused({ path: 'linkdir/x.env' });
      fs.symlinkSync(path.join(outside, 'target.env'), path.join(proj, 'link.env'));
      await refused({ path: 'link.env', name: 'K' });
      fs.mkdirSync(path.join(proj, '.git'));
      await refused({ path: '.git/config' });
      // A project in the home folder must not write the user's SSH folder.
      sessionsDb.create(db, { id: 'H', provider: 'claude-code', name: 'Home', workingDir: os.homedir() });
      terminalsDb.create(db, { id: 'tH', sessionId: 'H', type: 'claude-code', label: 'Home', config: { transport: 'structured', role: 'agent' } });
      const h = await create({ name: 'k', value: VALUE, sessionId: 'H' });
      const r = await use('tH', { id: h.body.id, file: { path: '.ssh/id_test_inbox' } });
      expect(r.status).toBe(403);
      expect(fs.existsSync(path.join(os.homedir(), '.ssh/id_test_inbox'))).toBe(false);
      expect(fs.existsSync(path.join(outside, 'x.env'))).toBe(false);
      expect(fs.existsSync(path.join(outside, 'target.env'))).toBe(false);
      expect((await request(app).get('/api/inbox/secrets?sessionId=A')).body.secrets[0].state).toBe('waiting');
    });

    it('refuses a bad destination: none, two at once, a bad name', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A' });
      expect((await use('tA', { id: made.body.id })).status).toBe(400);
      expect((await use('tA', { id: made.body.id, file: { path: '.env' }, doppler: { name: 'K' } })).status).toBe(400);
      expect((await use('tA', { id: made.body.id, file: { path: '.env', name: 'bad name' } })).status).toBe(400);
      expect((await use('tA', { id: made.body.id, doppler: { name: '' } })).status).toBe(400);
    });
  });

  describe('use: Doppler', () => {
    it("sets the secret through the daemon's secrets service; the value never comes back", async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A' });
      const r = await use('tA', { id: made.body.id, doppler: { name: 'STRIPE_KEY' } });
      expect(r.status).toBe(200);
      expect(client.setSecret).toHaveBeenCalledWith('web', 'dev', 'STRIPE_KEY', VALUE);
      expect(r.body.message).toMatch(/STRIPE_KEY/);
      expect(r.body.message).toMatch(/doppler run/);
      expect(JSON.stringify(r.body)).not.toContain(VALUE);
      expect((await request(app).get('/api/inbox/secrets')).body.secrets[0]).toMatchObject({ state: 'used', usedTo: { kind: 'doppler', name: 'STRIPE_KEY' } });
    });

    it('a Doppler failure keeps the secret unused, and the error never carries the value', async () => {
      client.setSecret.mockRejectedValueOnce(new Error(`Doppler 400: bad value ${VALUE}`));
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A' });
      const r = await use('tA', { id: made.body.id, doppler: { name: 'STRIPE_KEY' } });
      expect(r.status).toBe(502);
      expect(JSON.stringify(r.body)).not.toContain(VALUE);
      expect((await request(app).get('/api/inbox/secrets')).body.secrets[0].state).toBe('waiting');
    });

    it('Doppler not connected: a plain message', async () => {
      fs.rmSync(path.join(tmp, 'doppler.json'));
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A' });
      const r = await use('tA', { id: made.body.id, doppler: { name: 'STRIPE_KEY' } });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Doppler is not connected/);
    });
  });

  describe('use: reveal', () => {
    it('refused unless the owner allowed it; allowed: the value comes back once', async () => {
      const no = await create({ name: 'k', value: VALUE, sessionId: 'A' });
      const r = await use('tA', { id: no.body.id, reveal: true });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/owner did not allow/);
      expect(r.body.error).toMatch(/file|Doppler/);
      expect((await request(app).get('/api/inbox/secrets')).body.secrets[0].state).toBe('waiting');

      const yes = await create({ name: 'k2', value: VALUE, sessionId: 'A', allowReveal: true });
      const ok = await use('tA', { id: yes.body.id, reveal: true });
      expect(ok.status).toBe(200);
      expect(ok.body.value).toBe(VALUE);
      expect(ok.body.message).not.toContain(VALUE);
      expect((await use('tA', { id: yes.body.id, reveal: true })).status).toBe(410);
    });
  });

  describe('use: scope', () => {
    it('a project secret: any thread of the project; another project is refused with the unknown-ID answer', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A', allowReveal: true });
      const other = await use('tB', { id: made.body.id, reveal: true });
      const unknown = await use('tB', { id: 'ZZZZZZ', reveal: true });
      expect(other.status).toBe(404);
      expect(other.body).toEqual({ error: other.body.error });
      // The same words for "exists elsewhere" and "does not exist" (the ID differs, nothing else).
      expect(other.body.error.replace(made.body.id, 'X')).toBe(unknown.body.error.replace('ZZZZZZ', 'X'));
      expect((await use('tA2', { id: made.body.id, reveal: true })).status).toBe(200);
    });

    it('a thread secret: that thread only', async () => {
      const made = await create({ name: 'k', value: VALUE, terminalId: 'tA', allowReveal: true });
      expect((await use('tA2', { id: made.body.id, reveal: true })).status).toBe(404);
      expect((await use('tA', { id: made.body.id, reveal: true })).status).toBe(200);
    });

    it('an expired or used secret of another scope still gets the unknown-ID answer', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A', allowReveal: true });
      now += SECRET_TTL_MS + 1;
      const r = await use('tB', { id: made.body.id, reveal: true });
      expect(r.status).toBe(404);
      expect(r.body.error).not.toMatch(/expired/);
    });

    it('the owner (no thread key) cannot use a secret through this route', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A', allowReveal: true });
      const r = await request(app).post('/api/inbox/secrets/use').send({ id: made.body.id, reveal: true });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain(VALUE);
    });
  });

  describe('expiry', () => {
    it('an unused secret expires after 24 hours: the list says expired, the value is gone, a use says expired', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A', allowReveal: true });
      now += SECRET_TTL_MS + 1;
      expect(fs.existsSync(path.join(valueDir(), made.body.id))).toBe(true); // no timer
      expect((await request(app).get('/api/inbox/secrets')).body.secrets[0].state).toBe('expired');
      expect(fs.existsSync(path.join(valueDir(), made.body.id))).toBe(false);
      const r = await use('tA', { id: made.body.id, reveal: true });
      expect(r.status).toBe(410);
      expect(r.body.error).toMatch(/expired/);
    });

    it('a lookup alone deletes an expired value', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A', allowReveal: true });
      now += SECRET_TTL_MS + 1;
      await use('tA', { id: made.body.id, reveal: true });
      expect(fs.existsSync(path.join(valueDir(), made.body.id))).toBe(false);
    });
  });

  describe('rate limit', () => {
    it('10 failed lookups in 10 minutes, then 429 for that thread only, even for a good ID; the window passes', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A', allowReveal: true });
      for (let i = 0; i < 10; i++) expect((await use('tA', { id: 'ZZZZZZ', reveal: true })).status).toBe(404);
      const blocked = await use('tA', { id: made.body.id, reveal: true });
      expect(blocked.status).toBe(429);
      expect(JSON.stringify(blocked.body)).not.toContain(VALUE);
      // Another thread is not blocked.
      expect((await use('tA2', { id: 'ZZZZZZ', reveal: true })).status).toBe(404);
      now += 10 * 60_000 + 1;
      expect((await use('tA', { id: made.body.id, reveal: true })).status).toBe(200);
    });

    it('a bad destination is not a failed lookup', async () => {
      const made = await create({ name: 'k', value: VALUE, sessionId: 'A', allowReveal: true });
      for (let i = 0; i < 12; i++) await use('tA', { id: made.body.id, file: { path: '../x' } });
      expect((await use('tA', { id: made.body.id, reveal: true })).status).toBe(200);
    });
  });

  it('the value is in no log line, through every path above', async () => {
    const a = await create({ name: 'k', value: VALUE, sessionId: 'A' });
    await use('tA', { id: a.body.id, file: { path: '../x', name: 'K' } });
    await use('tA', { id: a.body.id, reveal: true });
    client.setSecret.mockRejectedValueOnce(new Error(`boom ${VALUE}`));
    await use('tA', { id: a.body.id, doppler: { name: 'K' } });
    await use('tB', { id: a.body.id, reveal: true });
    await use('tA', { id: a.body.id, file: { path: '.env.local', name: 'K' } });
    await create({ name: 'k', value: VALUE, sessionId: 'nope' });
    expect(logs.join('\n')).not.toContain(VALUE);
  });
});
