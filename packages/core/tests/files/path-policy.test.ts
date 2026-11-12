// The path policy (src/files/path-policy.ts) and every file route under it (src/routes/files.ts):
// the system's own trees are never served; a hosted box serves the person's folders only; a business
// person gets the project, without the folders that configure an agent program.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
vi.hoisted(() => { process.env.DISPATCH_UPLOAD_DIR = `${process.env.TMPDIR || '/tmp'}/dispatch-upload-policy-${process.pid}`; });
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createFilesRouter, UPLOAD_TMP_DIR } from '../../src/routes/files.js';
import { createStateRouter } from '../../src/routes/state.js';
import { PathPolicy, inSystemTree, type PathPolicyContext } from '../../src/files/path-policy.js';
import { defaultSecretRoots } from '../../src/files/secret-paths.js';

afterAll(() => { fs.rmSync(UPLOAD_TMP_DIR, { recursive: true, force: true }); });

interface World {
  home: string; dataDir: string; appDir: string; outside: string;
  /** `~/projects/mine`: the project of the request. */
  project: string;
  /** `~/projects/other`: another project of the same person. */
  other: string;
}

let w: World;
beforeEach(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'path-policy-')));
  const home = path.join(base, 'home');
  w = { home, dataDir: path.join(home, '.dispatch'), appDir: path.join(base, 'app'), outside: path.join(base, 'outside'), project: path.join(home, 'projects', 'mine'), other: path.join(home, 'projects', 'other') };
  for (const d of [w.dataDir, w.appDir, w.outside, w.project, w.other, path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.ssh'), path.join(home, 'notes')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(w.project, 'report.txt'), 'the report');
  fs.writeFileSync(path.join(w.project, 'pic.png'), 'png bytes');
  fs.writeFileSync(path.join(w.other, 'theirs.txt'), 'other project');
  fs.writeFileSync(path.join(w.outside, 'secret.txt'), 'outside secret');
  fs.writeFileSync(path.join(w.dataDir, 'dispatch.db'), 'the database');
  fs.writeFileSync(path.join(w.dataDir, 'state.json'), 'daemon state');
  fs.writeFileSync(path.join(w.appDir, 'server.js'), 'the app');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"hooks":{}}');
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), 'claude credential');
  fs.writeFileSync(path.join(home, '.bash_history'), 'export TOKEN=abc');
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'ssh key');
  fs.writeFileSync(path.join(home, 'notes', 'todo.txt'), 'a note in the home folder');
});
afterEach(() => { fs.rmSync(path.dirname(w.home), { recursive: true, force: true }); });

const ctx = (over: Partial<PathPolicyContext>): PathPolicyContext => ({
  hosted: true, profile: 'developer', home: w.home, dataDir: w.dataDir, appDir: w.appDir, projectDirs: () => [w.project, w.other], ...over,
});
const policyOf = (over: Partial<PathPolicyContext>) => new PathPolicy(() => ctx(over));
const local = () => policyOf({ hosted: false, appDir: null });
const hostedDev = () => policyOf({});
const business = () => policyOf({ profile: 'business' });

describe('the policy itself', () => {
  test('the system trees are refused on every install, by text and by where a link leads', () => {
    for (const p of ['/proc/self/environ', '/proc/1/environ', '/proc/1/cmdline', '/proc/1/maps', '/proc/net/tcp', '/sys/kernel', '/dev/mem', '/run/secrets/x', '/var/run/docker.sock', '/proc']) {
      expect(inSystemTree(p), p).toBe(true);
      for (const policy of [local(), hostedDev(), business()]) expect(policy.problem(p, { project: w.project, use: 'read' }), p).toBe('system');
    }
    expect(inSystemTree('/process/x')).toBe(false);
    expect(inSystemTree('/home/proc/x')).toBe(false);
    // A link in the project that leads there.
    fs.symlinkSync('/proc/self/environ', path.join(w.project, 'env-link'));
    expect(local().problem(path.join(w.project, 'env-link'), { project: w.project, use: 'read' })).toBe('system');
  });

  test('a local install keeps the read of any other absolute path', () => {
    for (const p of [path.join(w.outside, 'secret.txt'), path.join(w.dataDir, 'state.json'), path.join(w.appDir, 'server.js'), path.join(w.home, '.claude', 'settings.json'), '/etc/hosts']) {
      expect(local().problem(p, { project: w.project, use: 'read' }), p).toBeNull();
    }
  });

  test('hosted developer: the home folder and the project folders; not Dispatch, not the app, not the harness folders, not outside', () => {
    const p = hostedDev();
    const q = { project: w.project, use: 'read' as const };
    expect(p.problem(path.join(w.project, 'report.txt'), q)).toBeNull();
    expect(p.problem(path.join(w.other, 'theirs.txt'), q)).toBeNull();
    expect(p.problem(path.join(w.home, 'notes', 'todo.txt'), q)).toBeNull();
    expect(p.problem(path.join(w.outside, 'secret.txt'), q)).toBe('outside');
    expect(p.problem('/etc/passwd', q)).toBe('outside');
    expect(p.problem('/etc/claude-code/managed-settings.json', q)).toBe('outside');
    expect(p.problem(path.join(w.dataDir, 'state.json'), q)).toBe('daemon');
    expect(p.problem(path.join(w.dataDir, 'dispatch.db'), q)).toBe('daemon');
    expect(p.problem(w.dataDir, q)).toBe('daemon');
    expect(p.problem(path.join(w.appDir, 'server.js'), q)).toBe('daemon');
    expect(p.problem(path.join(w.home, '.claude', 'settings.json'), q)).toBe('harness');
    expect(p.problem(path.join(w.home, '.Claude', 'settings.json'), q)).toBe('harness');
    expect(p.problem(path.join(w.home, '.codex', 'config.toml'), q)).toBe('harness');
    expect(p.problem(path.join(w.home, '.claude.json'), q)).toBe('harness');
  });

  test('business: the project of the request only, and nothing that configures an agent program', () => {
    const p = business();
    const q = { project: w.project, use: 'read' as const };
    expect(p.problem(path.join(w.project, 'report.txt'), q)).toBeNull();
    expect(p.problem(path.join(w.project, 'new', 'file.txt'), { ...q, use: 'write' })).toBeNull();
    expect(p.problem(path.join(w.project, '.dispatch', 'inbox', 'a.csv'), q)).toBeNull();
    expect(p.problem(path.join(w.other, 'theirs.txt'), q)).toBe('outside');
    expect(p.problem(path.join(w.home, 'notes', 'todo.txt'), q)).toBe('outside');
    expect(p.problem(w.home, q)).toBe('outside');
    for (const rel of ['.claude/settings.json', '.claude/hooks/x.sh', '.codex/config.toml', '.git/hooks/pre-commit', '.git/config', '.mcp.json', 'sub/.mcp.json', 'sub/.Claude/x', '.dispatch/other', 'opencode.json', '.cursor/rules', '.envrc']) {
      expect(p.problem(path.join(w.project, rel), q), rel).toBe('harness');
    }
    // A project that is not a folder of ~/projects serves nothing to a business person.
    expect(p.problem(path.join(w.home, 'notes', 'todo.txt'), { project: path.join(w.home, 'notes'), use: 'read' })).toBe('outside');
    expect(p.problem(path.join(w.home, 'projects', 'x'), { project: path.join(w.home, 'projects'), use: 'read' })).toBe('outside');
  });

  test('a link is followed before anything is compared', () => {
    fs.symlinkSync(w.outside, path.join(w.project, 'out'));
    fs.symlinkSync(path.join(w.home, '.claude'), path.join(w.project, 'cfg'));
    fs.symlinkSync(w.dataDir, path.join(w.home, 'notes', 'd'));
    expect(hostedDev().problem(path.join(w.project, 'out', 'secret.txt'), { project: w.project, use: 'read' })).toBe('outside');
    expect(hostedDev().problem(path.join(w.project, 'cfg', 'settings.json'), { project: w.project, use: 'read' })).toBe('harness');
    expect(hostedDev().problem(path.join(w.home, 'notes', 'd', 'state.json'), { project: w.project, use: 'read' })).toBe('daemon');
    expect(business().problem(path.join(w.project, 'out', 'new.txt'), { project: w.project, use: 'write' })).toBe('outside');
    // Rename and delete act on the link itself: the link is in the project, wherever it points.
    expect(business().problem(path.join(w.project, 'out'), { project: w.project, use: 'write', self: true })).toBeNull();
  });

  test('a file with more than one name is refused on a hosted box (a hard link gives an outside file a name inside)', () => {
    fs.linkSync(path.join(w.outside, 'secret.txt'), path.join(w.project, 'innocent.txt'));
    const st = fs.statSync(path.join(w.project, 'innocent.txt'));
    expect(st.nlink).toBe(2);
    expect(business().openedProblem(st, path.join(w.project, 'innocent.txt'))).toBe('hardlink');
    expect(hostedDev().openedProblem(st, path.join(w.project, 'innocent.txt'))).toBe('hardlink');
    expect(hostedDev().openedProblem(st, path.join(w.project, 'node_modules', 'pkg', 'index.js'))).toBeNull();
    expect(business().openedProblem(st, path.join(w.project, 'node_modules', 'pkg', 'index.js'))).toBe('hardlink');
    expect(local().openedProblem(st, path.join(w.project, 'innocent.txt'))).toBeNull();
    expect(business().openedProblem(fs.statSync(path.join(w.project, 'report.txt')), path.join(w.project, 'report.txt'))).toBeNull();
  });
});

// ── every file route ────────────────────────────────────────────────────────────────────────────────

// One listening server for each app (closed after the test): a new listener for every request would
// churn through local ports, and a port another process just took answers with that process's status.
const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.close(); s.closeAllConnections(); } });

async function app(policy: PathPolicy, workingDir: string = w.project): Promise<http.Server> {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'mine', workingDir });
  sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'other', workingDir: w.other });
  const e = express();
  e.use(express.json());
  e.use('/api/sessions/:id/files', createFilesRouter(db, { secretRoots: defaultSecretRoots(w.dataDir, w.home), policy }));
  e.use('/api/state', createStateRouter(db, { policy }));
  const server = http.createServer(e);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return server;
}

const F = '/api/sessions/s1/files';
type Call = (e: http.Server, p: string) => request.Test;
/** Each route that takes a path, as one call with the path under test. */
const ROUTES: Record<string, Call> = {
  list: (e, p) => request(e).get(F).query({ path: p }),
  read: (e, p) => request(e).get(`${F}/read`).query({ path: p }),
  sniff: (e, p) => request(e).get(`${F}/read`).query({ path: p, sniff: '1' }),
  image: (e, p) => request(e).get(`${F}/image`).query({ path: p }),
  download: (e, p) => request(e).get(`${F}/download`).query({ path: p }),
  write: (e, p) => request(e).put(`${F}/write`).query({ path: p }).send({ content: 'written by the test' }),
  upload: (e, p) => request(e).post(`${F}/upload`).query({ path: p }).attach('file', Buffer.from('uploaded'), { filename: 'up.txt', contentType: 'text/plain' }),
  mkdir: (e, p) => request(e).post(`${F}/mkdir`).query({ path: p }),
  'rename-from': (e, p) => request(e).post(`${F}/rename`).send({ from: p, to: 'renamed-target' }),
  'rename-to': (e, p) => request(e).post(`${F}/rename`).send({ from: 'report.txt', to: p }),
  delete: (e, p) => request(e).delete(F).query({ path: p }),
};
const SECRETS = /outside secret|the database|daemon state|the app|claude credential|export TOKEN|ssh key|other project|a note in the home/;

/** Nothing outside the project changed, and nothing of it came back. */
function expectNoHarm(r: request.Response, what: string): void {
  expect(r.status, what).toBeGreaterThanOrEqual(400);
  expect(r.status, what).toBeLessThan(500);
  expect(JSON.stringify(r.body) + (r.text ?? ''), what).not.toMatch(SECRETS);
  expect(fs.readFileSync(path.join(w.outside, 'secret.txt'), 'utf8'), what).toBe('outside secret');
  expect(fs.readFileSync(path.join(w.other, 'theirs.txt'), 'utf8'), what).toBe('other project');
  expect(fs.readFileSync(path.join(w.dataDir, 'dispatch.db'), 'utf8'), what).toBe('the database');
  expect(fs.existsSync(path.join(w.home, '.claude', 'settings.json')), what).toBe(true);
  expect(fs.readdirSync(w.outside), what).toEqual(['secret.txt']);
}

describe.each([
  ['business', () => business()],
  ['hosted developer', () => hostedDev()],
] as const)('every file route, %s', (_name, make) => {
  test.each(Object.keys(ROUTES))('%s: traversal, encodings, another project, the system trees, Dispatch and harness folders', async (route) => {
    const e = await app(make());
    const attacks = [
      '../other/theirs.txt', '../../../outside/secret.txt', 'sub/../../other/theirs.txt', '..', '../..', 'report.txt/../../other/theirs.txt',
      path.join(w.outside, 'secret.txt'), '/etc/passwd', '/proc/self/environ', '/proc/1/environ', '/proc/1/cmdline', '/sys/kernel/x', '/dev/null',
      path.join(w.dataDir, 'dispatch.db'), path.join(w.dataDir, 'state.json'), path.join(w.appDir, 'server.js'),
      path.join(w.home, '.claude', 'settings.json'), path.join(w.home, '.claude', '.credentials.json'), path.join(w.home, '.bash_history'), path.join(w.home, '.ssh', 'id_ed25519'),
    ];
    for (const p of attacks) expectNoHarm(await ROUTES[route](e, p), `${route} ${p}`);
    // Encoded dots and slashes that arrive still encoded, and backslashes, are plain characters of a NAME on
    // this system: such a path stays inside the project whatever the route does with it. Nothing outside changes.
    for (const p of ['..%2f..%2foutside%2fsecret.txt', '%2e%2e/%2e%2e/outside/secret.txt', '..\\..\\outside\\secret.txt', '%252e%252e%252fsecret.txt']) {
      const r = await ROUTES[route](e, p);
      expect(JSON.stringify(r.body) + (r.text ?? ''), `${route} ${p}`).not.toMatch(SECRETS);
      expect(fs.readdirSync(w.outside), `${route} ${p}`).toEqual(['secret.txt']);
      expect(fs.readFileSync(path.join(w.outside, 'secret.txt'), 'utf8')).toBe('outside secret');
      expect(fs.readdirSync(path.dirname(w.home)).sort(), `${route} ${p}`).toEqual(['app', 'home', 'outside']);
      expect(fs.readdirSync(path.join(w.home, 'projects')).sort(), `${route} ${p}`).toEqual(['mine', 'other']);
    }
  });

  test.each(Object.keys(ROUTES))('%s: a link in the project that leads out is not a way out', async (route) => {
    fs.symlinkSync(w.outside, path.join(w.project, 'out'));
    fs.symlinkSync(path.join(w.outside, 'secret.txt'), path.join(w.project, 'leak.txt'));
    fs.symlinkSync(path.join(w.dataDir, 'dispatch.db'), path.join(w.project, 'db.png'));
    fs.symlinkSync('/proc/self/environ', path.join(w.project, 'env.txt'));
    fs.symlinkSync(path.join(w.home, '.claude'), path.join(w.project, 'claude'));
    const e = await app(make());
    const paths = ['out/secret.txt', 'out/new.txt', 'leak.txt', 'db.png', 'env.txt', 'claude/settings.json', 'claude/new.json'];
    // Rename and delete act on the link itself (a person may remove a bad link); the others follow it.
    const followed = route === 'delete' || route === 'rename-from' || route === 'rename-to' ? ['out/secret.txt', 'out/new.txt', 'claude/settings.json', 'claude/new.json'] : paths;
    for (const p of followed) expectNoHarm(await ROUTES[route](e, p), `${route} ${p}`);
  });
});

describe('business: the reads that serve bytes', () => {
  test('a hard link to an outside file is not read, shown or downloaded, and not written through', async () => {
    fs.linkSync(path.join(w.outside, 'secret.txt'), path.join(w.project, 'innocent.txt'));
    fs.linkSync(path.join(w.outside, 'secret.txt'), path.join(w.project, 'innocent.png'));
    const e = await app(business());
    for (const [route, p] of [['read', 'innocent.txt'], ['download', 'innocent.txt'], ['image', 'innocent.png'], ['write', 'innocent.txt']] as const) {
      const r = await ROUTES[route](e, p);
      expect(r.status, route).toBe(403);
      expect(r.body.reason, route).toBe('hardlink');
      expect(JSON.stringify(r.body) + (r.text ?? '')).not.toMatch(SECRETS);
    }
    expect(fs.readFileSync(path.join(w.outside, 'secret.txt'), 'utf8')).toBe('outside secret');
  });

  test('the folders that configure an agent program are not listed, read or written; the inbox is', async () => {
    for (const d of ['.claude', '.git/hooks', '.dispatch/inbox', '.dispatch/state', 'docs']) fs.mkdirSync(path.join(w.project, d), { recursive: true });
    fs.writeFileSync(path.join(w.project, '.claude', 'settings.json'), '{}');
    fs.writeFileSync(path.join(w.project, '.mcp.json'), '{}');
    fs.writeFileSync(path.join(w.project, '.dispatch', 'inbox', 'a.csv'), 'a,b');
    fs.writeFileSync(path.join(w.project, 'docs', 'x.md'), 'doc');
    const e = await app(business());
    const names = (await ROUTES.list(e, '.')).body.map((x: { name: string }) => x.name).sort();
    expect(names).toEqual(['.dispatch', 'docs', 'pic.png', 'report.txt']);
    expect((await ROUTES.list(e, '.dispatch')).body.map((x: { name: string }) => x.name)).toEqual(['inbox']);
    const flat = (await request(e).get(`${F}/flat`)).body.files as string[];
    expect(flat.some((f) => f.startsWith('.claude') || f === '.mcp.json' || f.startsWith('.git/'))).toBe(false);
    expect(flat).toContain('docs/x.md');
    for (const p of ['.claude/settings.json', '.mcp.json', '.git/hooks/pre-commit', '.claude/hooks/run.sh', '.dispatch/state/x']) {
      for (const route of ['read', 'write', 'mkdir', 'delete', 'download', 'upload'] as const) {
        const r = await ROUTES[route](e, p);
        expect(r.status, `${route} ${p}`).toBe(403);
      }
    }
    expect(fs.readFileSync(path.join(w.project, '.claude', 'settings.json'), 'utf8')).toBe('{}');
    expect(fs.existsSync(path.join(w.project, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect((await ROUTES.read(e, '.dispatch/inbox/a.csv')).body.content).toBe('a,b');
    expect((await request(e).post(`${F}/inbox`).attach('file', Buffer.from('x'), { filename: 'n.txt', contentType: 'text/plain' })).status).toBe(200);
  });

  test('the ordinary work of a person still works: read, write, list, upload, rename, delete in the project', async () => {
    const e = await app(business());
    expect((await ROUTES.read(e, 'report.txt')).body.content).toBe('the report');
    expect((await ROUTES.read(e, path.join(w.project, 'report.txt'))).body.content).toBe('the report'); // its own absolute path
    expect((await ROUTES.write(e, 'new.txt')).status).toBe(200);
    expect((await ROUTES.mkdir(e, 'folder/sub')).status).toBe(200);
    expect((await ROUTES.upload(e, 'folder')).status).toBe(200);
    expect((await ROUTES.image(e, 'pic.png')).status).toBe(200);
    expect((await ROUTES.download(e, 'report.txt')).status).toBe(200);
    expect((await ROUTES['rename-to'](e, 'folder/report.txt')).status).toBe(200);
    expect((await ROUTES.delete(e, 'new.txt')).status).toBe(200);
  });

  test('a project that is not under ~/projects serves nothing to a business person', async () => {
    const e = await app(business(), path.join(w.home, 'notes'));
    for (const route of ['list', 'read', 'write', 'download'] as const) {
      const r = await ROUTES[route](e, route === 'list' ? '.' : 'todo.txt');
      expect(r.status, route).toBe(403);
      expect(JSON.stringify(r.body)).not.toMatch(SECRETS);
    }
  });
});

describe('hosted developer and local installs', () => {
  test('hosted developer: "View file" ends at the home folder', async () => {
    const e = await app(hostedDev());
    expect((await ROUTES.read(e, path.join(w.home, 'notes', 'todo.txt'))).body.content).toBe('a note in the home folder');
    expect((await ROUTES.read(e, path.join(w.other, 'theirs.txt'))).body.content).toBe('other project');
    expect((await ROUTES.read(e, path.join(w.outside, 'secret.txt'))).status).toBe(403);
  });

  test('local: an absolute path outside the project is still read; the system trees are not', async () => {
    const e = await app(local());
    expect((await ROUTES.read(e, path.join(w.outside, 'secret.txt'))).body.content).toBe('outside secret');
    for (const p of ['/proc/self/environ', '/proc/1/environ', '/sys/kernel/x', '/dev/null']) {
      const r = await ROUTES.read(e, p);
      expect(r.status, p).toBe(403);
      expect(r.body.reason, p).toBe('system');
    }
    // What was typed into a shell is a credential file like the others (files/secret-paths.ts).
    expect((await ROUTES.read(e, path.join(w.home, '.bash_history'))).status).toBe(403);
  });

  test('the folder browser and "make a folder": the same policy', async () => {
    const dev = await app(hostedDev());
    expect((await request(dev).get('/api/state/browse').query({ path: w.home })).status).toBe(200);
    for (const p of ['/', '/etc', '/proc', w.dataDir, w.appDir, w.outside, path.join(w.home, '.claude')]) {
      expect((await request(dev).get('/api/state/browse').query({ path: p })).status, `browse ${p}`).toBe(403);
      expect((await request(dev).post('/api/state/mkdir').query({ path: path.join(p, 'made-by-test') })).status, `mkdir ${p}`).toBe(403);
    }
    expect(fs.existsSync(path.join(w.outside, 'made-by-test'))).toBe(false);
    const loc = await app(local());
    expect((await request(loc).get('/api/state/browse').query({ path: w.outside })).status).toBe(200);
    expect((await request(loc).get('/api/state/browse').query({ path: '/proc' })).status).toBe(403);
  });
});
