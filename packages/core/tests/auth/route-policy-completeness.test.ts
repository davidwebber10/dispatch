import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { policyHandlerOf, policyKindOf, type PolicyKind } from '../../src/auth/route-policy.js';
import type { EndlessService } from '../../src/endless/service.js';
import { LimitSnapshots } from '../../src/limits/snapshot.js';

/**
 * EXTEND HERE. Every route whose first handler is a `keyRoute(...)` must be listed, as
 * `METHOD /full/path` (Express path templates, e.g. `POST /api/sessions/:id/terminals`).
 * Tasks 8 to 11 add their rows when they declare a key rule; a route that gains or loses a
 * key rule without a matching edit here fails the second test below.
 */
const EXPECTED_KEY_ROUTES: string[] = [
  // The company-system servers (os/tools-proxy.ts): a thread key on loopback only.
  'POST /api/os/mcp/:system',
  'GET /api/os/mcp/:system',
  'DELETE /api/os/mcp/:system',
  'POST /api/plugins/:id/assist',
  // Coach plan (2026-11-07): the assist meter and share for a plugin's own key; push; usage and analytics reads.
  'GET /api/plugins/:id/assist/usage',
  'GET /api/plugins/:id/assist/share',
  // Coach review fix (finding 1): the worker reads its own budget (writing it stays owner-only).
  'GET /api/plugins/:id/budget',
  'POST /api/plugins/:id/notify',
  'GET /api/usage-limits/summary',
  'GET /api/analytics/summary',
  'GET /api/analytics/series',
  'GET /api/analytics/top',
  'GET /api/analytics/records',
  'GET /api/analytics/control-plane',
  'GET /api/analytics/tracking',
  'GET /api/plugins/:id/data',
  'GET /api/plugins/:id/data/:key',
  'PUT /api/plugins/:id/data/:key',
  'DELETE /api/plugins/:id/data/:key',
  'GET /api/plugins/:id/settings',
  'PUT /api/plugins/:id/settings',
  'POST /api/plugins/:id/files',
  'GET /api/skills',
  // One route with two patterns (the bare /worker and /worker/*): Express lists the array as one path.
  '_ALL /api/plugins/:id/worker,/plugins/:id/worker/*',
  'DELETE /api/plugins/:id/files/:fileId',
  'GET /api/sessions/:sessionId/ledger/card',
  'GET /api/sessions/:sessionId/ledger/:itemId/source',
  'GET /api/plugins',
  // Task 8: terminal and session routes
  'GET /api/sessions',
  'GET /api/sessions/:id/terminals',
  'POST /api/sessions/:id/terminals',
  'GET /api/sessions/:id/overseer/worker-defaults',
  'GET /api/terminals/:terminalId',
  'GET /api/terminals/:terminalId/conversation',
  // W3-D: the journal page has the key rules of the conversation route.
  'GET /api/terminals/:terminalId/journal',
  // Final review of v4.5.0 (I2): an image that the journal keeps outside its payload; the same key rules.
  'GET /api/terminals/:terminalId/journal/images/:imageId',
  'GET /api/terminals/:terminalId/permission',
  'POST /api/terminals/:terminalId/message',
  'POST /api/terminals/:terminalId/permission',
  'POST /api/terminals/:terminalId/report-status',
  'POST /api/terminals/:terminalId/start',
  'DELETE /api/terminals/:terminalId',
  // Task 9: watches, ledger, events, auth requests
  'POST /api/watches',
  'GET /api/watches',
  'DELETE /api/watches/:id',
  'POST /api/events/:provider/:terminalId',
  'POST /api/auth-requests',
  'POST /api/sessions/:sessionId/ledger',
  'POST /api/sessions/:sessionId/ledger/list',
  'POST /api/sessions/:sessionId/ledger/note',
  'POST /api/sessions/:sessionId/ledger/import',
  'POST /api/sessions/:sessionId/ledger/handoff',
  'POST /api/sessions/:sessionId/ledger/:itemId/resolve',
  'POST /api/sessions/:sessionId/ledger/show',
  'POST /api/sessions/:sessionId/ledger/decide-self',
  'POST /api/sessions/:sessionId/ledger/:itemId/add-from-agent',
  'POST /api/sessions/:sessionId/ledger/:itemId/decide-self',
  'POST /api/sessions/:sessionId/ledger/:itemId/mark-default',
  'POST /api/sessions/:sessionId/ledger/:itemId/title',
  // SEC-20: a thread may create these, and the creator is recorded
  'POST /api/integrations',
  'GET /api/integrations', // the list, with every header and env value masked
  'POST /api/roles/:name/enable',
  'POST /api/agents/schedules',
  // Task 10: Chat routes
  'GET /api/endless/threads',
  'GET /api/endless/project',
  'POST /api/endless/arm',
  'POST /api/endless/disarm',
  'POST /api/endless/ledger/:action',
  'GET /api/endless/zoom',
  'GET /api/endless/date',
];

/** Routes under `/api` that any principal may call (`publicRoute`). */
const EXPECTED_PUBLIC_API_ROUTES: string[] = ['GET /api/whoami'];
// (`POST /api/access/login` is public too; it exists only with the access gate, which `createApp` does not build.)

interface Found { id: string; kind: PolicyKind | undefined }

function mountPath(layer: any): string {
  if (layer.regexp?.fast_slash) return '';
  let i = 0;
  return layer.regexp.source
    .replace('\\/?(?=\\/|$)', '')
    .replace(/^\^/, '')
    .replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, () => '/:' + layer.keys[i++].name)
    .replace(/\\\//g, '/');
}

function walk(stack: any[], prefix: string, out: Found[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const p = typeof layer.route.path === 'string' ? layer.route.path : String(layer.route.path);
      const kind = policyKindOf(policyHandlerOf(layer.route));
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ id: `${method.toUpperCase()} ${(prefix + p).replace(/(.)\/$/, '$1')}`, kind });
      }
    } else if (layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
}

function buildRoutes(): Found[] {
  const db = new Database(':memory:');
  initSchema(db);
  const endless = { available: true } as unknown as EndlessService;
  const usageLimits = { snapshots: new LimitSnapshots(db), accountFor: () => 'acct' };
  const app = createApp({ db, skipPty: true, endless, usageLimits });
  const out: Found[] = [];
  walk((app as any)._router.stack, '', out);
  return out;
}

describe('route policy completeness', () => {
  const routes = buildRoutes();

  test('the walk finds the mounted routes, the endless routes included', () => {
    const ids = routes.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(100);
    expect(ids).toContain('GET /api/whoami');
    expect(ids).toContain('GET /api/sessions');
    expect(ids).toContain('POST /api/sessions/:id/terminals');
    expect(ids).toContain('GET /api/sessions/:id/files/read');
    expect(ids).toContain('GET /api/sessions/:id/git/status');
    expect(ids.some((i) => i.startsWith('GET /api/endless/'))).toBe(true);
  });

  test('every route starts with a policy handler', () => {
    const untagged = routes.filter((r) => r.kind === undefined).map((r) => r.id);
    expect(untagged).toEqual([]);
  });

  test('the key routes are exactly the expected list', () => {
    const keyRoutes = routes.filter((r) => r.kind === 'key').map((r) => r.id).sort();
    expect(keyRoutes).toEqual([...EXPECTED_KEY_ROUTES].sort());
  });

  test('the public routes under /api are exactly the expected list', () => {
    const pub = routes.filter((r) => r.kind === 'public' && r.id.split(' ')[1].startsWith('/api/')).map((r) => r.id).sort();
    expect(pub).toEqual([...EXPECTED_PUBLIC_API_ROUTES].sort());
  });

  test('the usage-limits route is mounted and owner only', () => {
    expect(routes.find((r) => r.id === 'GET /api/usage-limits')?.kind).toBe('owner');
  });

  test('the stats route is owner only', () => {
    expect(routes.find((r) => r.id === 'GET /api/access/no-credential-stats')?.kind).toBe('owner');
  });

  test('the push subscription routes (list, revoke, subscribe) are owner only', () => {
    for (const id of ['GET /api/push/subscriptions', 'DELETE /api/push/subscriptions/:deviceId', 'POST /api/push/subscribe']) {
      expect(routes.find((r) => r.id === id)?.kind, id).toBe('owner');
    }
  });

  test('the device routes are owner only', () => {
    for (const id of ['GET /api/access/devices', 'PATCH /api/access/devices/:id', 'DELETE /api/access/devices/:id', 'POST /api/access/devices/end-legacy', 'GET /api/access/addresses', 'POST /api/access/pair-code']) {
      expect(routes.find((r) => r.id === id)?.kind, id).toBe('owner');
    }
  });
});

describe('default deny in the full app', () => {
  test('a minted thread key is refused on a plain route and on the stats route, and the owner path still works', async () => {
    const request = (await import('supertest')).default;
    const db = new Database(':memory:');
    initSchema(db);
    const app = createApp({ db, skipPty: true, endless: { available: true } as unknown as EndlessService });
    const { key } = (app.locals.keys as import('../../src/auth/principals.js').KeyRegistry).mint({ kind: 'chat', startedBy: 'user' });
    const auth = { Authorization: `Bearer ${key}` };
    const plain = await request(app).get('/api/servers').set(auth);
    expect(plain.status).toBe(403);
    expect(plain.body.error).toBe('owner_only');
    expect((await request(app).get('/api/access/no-credential-stats').set(auth)).status).toBe(403);
    // The device list is owner only too (createApp has no device store, so the owner gets 404, a key 403).
    expect((await request(app).get('/api/access/devices').set(auth)).status).toBe(403);
    expect((await request(app).delete('/api/access/devices/abc').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/access/devices')).status).toBe(404);
    expect((await request(app).get('/api/access/addresses').set(auth)).status).toBe(403);
    // An integration can be created by a thread key, but changed or removed only by the owner.
    expect((await request(app).patch('/api/integrations/abc').set(auth).send({ enabled: false })).status).toBe(403);
    expect((await request(app).delete('/api/integrations/abc').set(auth)).status).toBe(403);
    // Push subscriptions: a key can neither list nor revoke them.
    expect((await request(app).get('/api/push/subscriptions').set(auth)).status).toBe(403);
    expect((await request(app).delete('/api/push/subscriptions/abc').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/whoami').set(auth)).body).toEqual({ kind: 'chat', startedBy: 'user' });
    expect((await request(app).get('/api/servers')).status).toBe(200);
  });

  test('without a Chat service, /api/endless answers 503 to the owner', async () => {
    const request = (await import('supertest')).default;
    const db = new Database(':memory:');
    initSchema(db);
    const app = createApp({ db, skipPty: true });
    expect((await request(app).get('/api/endless/messages')).status).toBe(503);
  });
});

// W3-A: createApp and startServer are one build (daemon/build.ts), so the list is mounted in one place.
describe('one mount list', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src', rel), 'utf8');
  const daemonFiles = fs.readdirSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/daemon')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  test('buildDaemon calls mountApiRoutes once, and createApp and startServer both call buildDaemon', () => {
    const build = read('daemon/build.ts');
    expect(build).toContain("import { mountApiRoutes, type ApiRouteDeps } from '../server-routes.js'");
    expect(build.match(/mountApiRoutes\(app,/g)).toHaveLength(1);
    const server = read('server.ts');
    expect(server).not.toContain('mountApiRoutes');
    expect(server.match(/buildDaemon\(\{/g)).toHaveLength(2);
  });

  test('the daemon files mount no /api route on the app itself', () => {
    const own = ['server.ts', ...daemonFiles.map((f) => `daemon/${f}`)]
      .flatMap((f) => read(f).match(/app\.(use|get|post|put|patch|delete|all)\(\s*'\/api[^']*'/g) ?? []);
    // None: the login route is in a policyRouter too (daemon/wire-auth.ts), like every route.
    expect(own).toEqual([]);
    expect(read('daemon/wire-auth.ts')).toContain("login.post('/api/access/login', publicRoute,");
  });
});
