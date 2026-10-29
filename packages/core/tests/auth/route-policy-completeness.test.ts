import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import { policyKindOf, type PolicyKind } from '../../src/auth/route-policy.js';
import type { EndlessService } from '../../src/endless/service.js';
import { LimitSnapshots } from '../../src/limits/snapshot.js';

/**
 * EXTEND HERE. Every route whose first handler is a `keyRoute(...)` must be listed, as
 * `METHOD /full/path` (Express path templates, e.g. `POST /api/sessions/:id/terminals`).
 * Tasks 8 to 11 add their rows when they declare a key rule; a route that gains or loses a
 * key rule without a matching edit here fails the second test below.
 */
const EXPECTED_KEY_ROUTES: string[] = [
  // Task 8: terminal and session routes
  'GET /api/sessions',
  'GET /api/sessions/:id/terminals',
  'POST /api/sessions/:id/terminals',
  'GET /api/sessions/:id/overseer/worker-defaults',
  'GET /api/terminals/:terminalId',
  'GET /api/terminals/:terminalId/conversation',
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
  'POST /api/sessions/:id/previews',
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
      const kind = policyKindOf(layer.route.stack[0]?.handle);
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

describe('one mount list', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.ts'), 'utf8',
  );

  test('createApp and startServer both call mountApiRoutes', () => {
    expect(src).toContain("import { mountApiRoutes } from './server-routes.js'");
    expect(src.match(/mountApiRoutes\(app,/g)).toHaveLength(2);
  });

  test('server.ts mounts no /api route of its own except the login route', () => {
    const own = src.match(/app\.(use|get|post|put|patch|delete|all)\(\s*'\/api[^']*'/g) ?? [];
    expect(own).toEqual(["app.post('/api/access/login'"]);
  });
});
