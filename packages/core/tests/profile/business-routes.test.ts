// The profile gate, proved against the LIVE app (profile/business-gate.ts, profile/business-routes.ts,
// http/canonical-path.ts): every registered route and every WebSocket is enumerated from the app object;
// each has a row; and no spelling of a path reaches a handler with a verdict other than the canonical one.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { closeKits, kit, type Kit } from '../daemon/kit.js';
import { inspectRoutes, type RegisteredRoute } from '../../src/http/route-registry.js';
import { BUSINESS_ROUTES } from '../../src/profile/business-routes.js';
import { SOCKET_ROUTES, isBusinessGuard } from '../../src/profile/business-gate.js';
import type { EndlessService } from '../../src/endless/service.js';
import * as terminalsDb from '../../src/db/terminals.js';

const envWith = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of ['DISPATCH_PROFILE', 'OS_BASE_URL', 'OS_BOX_TOKEN', 'DISPATCH_BOX_TOKEN', 'OS_PUBLIC_URL', 'DISPATCH_OWNER_EMAIL', 'DISPATCH_BASE_PATH']) delete env[k];
  return { ...env, ...extra };
};

/** A web build of one file, so the page routes exist as they do in the daemon. */
function webDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><base href="/" /></head><body></body></html>');
  return dir;
}

function build(profile: 'business' | 'developer', extra: Record<string, string> = {}): Kit {
  const k = kit({ env: envWith({ DISPATCH_PROFILE: profile, ...extra }), webDist: webDist(), endless: { available: true } as unknown as EndlessService });
  return k;
}

const REACHED = 299;

/**
 * Replace everything after the profile guard of each route with a marker that answers 299 and names the
 * route. So a request that gets 299 passed the guard of THAT route and would have run its handlers.
 */
function instrument(routes: RegisteredRoute[]): void {
  for (const r of routes) {
    const stack = r.route.stack as Array<Record<string, unknown>>;
    expect(isBusinessGuard(stack[0].handle), r.pattern).toBe(true);
    const marker = Object.assign(Object.create(Object.getPrototypeOf(stack[0])), stack[0], {
      handle: (_req: unknown, res: http.ServerResponse) => {
        res.statusCode = REACHED;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ reached: r.pattern }));
      },
    });
    stack.splice(1, stack.length - 1, marker);
  }
}

interface Answer { status: number; body: any }

/** One request with the path sent byte for byte (no client-side normalisation). */
function raw(port: number, method: string, target: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = method === 'GET' || method === 'HEAD' ? null : '{}';
    const req = http.request({ host: '127.0.0.1', port, method, path: target, agent: keepAlive, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': '2' } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let body: any = null; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 8 });

/** The canonical URL of a route pattern: each parameter gets a plain value (`project`: a real project id). */
function canonicalUrl(pattern: string, project: string): string | null {
  if (pattern === '(page)') return '/some/page';
  const first = pattern.split(' | ')[0];
  return first.replace(/^\/api\/sessions\/:(id|sessionId)/, `/api/sessions/${project}`).replace(/:[A-Za-z]+/g, 'p1').replace(/\*/g, 'file.txt');
}

/** The index of each static segment of a pattern (a parameter and a wildcard are not static). */
function staticSegments(pattern: string): number[] {
  if (pattern === '(page)') return [];
  return pattern.split(' | ')[0].split('/').map((seg, i) => (i > 0 && seg && !seg.startsWith(':') && seg !== '*' ? i : -1)).filter((i) => i > 0);
}

const flipCase = (s: string): string | null => {
  const i = s.search(/[a-z]/);
  return i === -1 ? null : s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
};
/** The first letter as its full-width form (U+FF41…), percent-encoded as UTF-8. */
const fullWidth = (s: string): string | null => {
  const i = s.search(/[a-z]/);
  if (i === -1) return null;
  return s.slice(0, i) + encodeURIComponent(String.fromCodePoint(0xff41 + (s.charCodeAt(i) - 97))) + s.slice(i + 1);
};
const escapeFirst = (s: string): string => `%${s.charCodeAt(0).toString(16)}${s.slice(1)}`;

/** Every mutated spelling of `url` (a canonical path with no query). */
function mutations(url: string, statics: number[]): string[] {
  const out = new Set<string>();
  const segs = url.split('/');
  const join = (parts: string[]) => parts.join('/');
  for (const i of statics) {
    for (const f of [flipCase, fullWidth, escapeFirst, (s: string) => `${s};a=b`, (s: string) => `${s}%00`, (s: string) => s.toUpperCase() === s ? null : s.toUpperCase()]) {
      const changed = f(segs[i]);
      if (changed !== null && changed !== segs[i]) out.add(join(segs.map((s, j) => (j === i ? changed : s))));
    }
  }
  // Each slash: doubled, encoded three ways, with a dot segment, with a climb and a way back.
  for (let i = 1; i < segs.length; i++) {
    const head = join(segs.slice(0, i));
    const tail = join(segs.slice(i));
    out.add(`${head}//${tail}`);
    out.add(`${head}/./${tail}`);
    out.add(`${head}/x/../${tail}`);
    out.add(`${head}/%2e/${tail}`);
    out.add(`${head}/%2e%2e/${segs[i - 1] || 'x'}/${tail}`);
    if (i > 1) for (const enc of ['%2f', '%2F', '%5c', '%5C', '\\']) out.add(`${head}${enc}${tail}`);
  }
  out.add(`/${url}`);
  out.add(`${url}/`);
  out.add(`${url}//`);
  out.add(`${url}%00`);
  out.add(`${url}%2f`);
  out.add(`${url};a=b`);
  out.add(`${url}/.`);
  out.add(`${url}/..`);
  out.delete(url);
  return [...out];
}

describe('the table covers the live app', () => {
  afterAll(() => closeKits());

  test('every registered route has a row, and every row is a registered route', () => {
    const open = inspectRoutes(build('developer').daemon.app);
    expect(open.problems).toEqual([]);
    // The access gate adds the sign-in route (a build with `auth: 'gate'` and no box token).
    const gated = inspectRoutes(kit({ env: envWith({}), auth: 'gate', webDist: webDist() }).daemon.app);
    expect(gated.problems).toEqual([]);
    const live = new Set<string>();
    for (const r of [...open.routes, ...gated.routes]) for (const m of r.methods) live.add(`${m} ${r.pattern}`);
    expect(live.size).toBeGreaterThan(280);
    const unclassified = [...live].filter((id) => !(id in BUSINESS_ROUTES)).sort();
    expect(unclassified, 'add a row to profile/business-routes.ts for each new route').toEqual([]);
    const stale = Object.keys(BUSINESS_ROUTES).filter((id) => !live.has(id)).sort();
    expect(stale, 'a row for a route that no longer exists').toEqual([]);
  });

  test('a route with no row is refused for a business person at run time, and served to a developer', async () => {
    for (const profile of ['business', 'developer'] as const) {
      const k = build(profile);
      // A route a later change might add and forget to classify. Registered the way every route is.
      const { policyRouter } = await import('../../src/auth/route-policy.js');
      const { mountRouter, sealRoutes } = await import('../../src/http/route-registry.js');
      const { GATE_LOCAL } = await import('../../src/profile/business-gate.js');
      const extra = policyRouter();
      extra.post('/thing', (_req, res) => { res.json({ ran: true }); });
      const app = k.daemon.app;
      // Before the page catch-all and the error handler: the app's own stack order decides.
      const stack = (app as unknown as { _router: { stack: unknown[] } })._router.stack;
      const at = stack.length;
      mountRouter(app, '/api/brand-new', extra);
      stack.splice(2, 0, ...stack.splice(at, 1)); // right after Express's own two layers (query, init)
      sealRoutes(app, (app.locals[GATE_LOCAL] as { ids: WeakMap<object, string> }).ids);
      const r = await raw(await k.port(), 'POST', '/api/brand-new/thing');
      if (profile === 'business') {
        expect(r.status).toBe(403);
        expect(r.body).toMatchObject({ code: 'not_available_in_profile', rule: 'unclassified' });
      } else {
        expect(r.body).toEqual({ ran: true });
      }
    }
  });

  test('a route registered around policyRouter stops the build', async () => {
    const { sealRoutes } = await import('../../src/http/route-registry.js');
    const k = build('developer');
    k.daemon.app.get('/api/outside', (_req, res) => { res.end(); });
    expect(() => sealRoutes(k.daemon.app, new WeakMap())).toThrow(/not registered through policyRouter/);
  });
});

describe.each(['business', 'developer'] as const)('no spelling of a path changes the verdict (%s)', (profile) => {
  let k: Kit;
  let port: number;
  let routes: RegisteredRoute[];
  let project: string;
  beforeAll(async () => {
    k = build(profile);
    // A real project: the files router looks its project up before any of its routes runs.
    project = k.daemon.services.sessionService.create({ name: 'p', provider: 'claude-code', workingDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gate-proj-')) }).id;
    routes = inspectRoutes(k.daemon.app).routes;
    instrument(routes);
    port = await k.port();
  });
  afterAll(() => closeKits());

  test('each canonical spelling gets the verdict of its row; each mutated spelling never reaches that route', async () => {
    let asked = 0;
    const wrong: string[] = [];
    for (const r of routes) {
      const url = canonicalUrl(r.pattern, project);
      if (!url) continue;
      for (const method of r.methods.map((m) => (m === 'ALL' ? 'POST' : m))) {
        const row = BUSINESS_ROUTES[`${method} ${r.pattern}`] ?? BUSINESS_ROUTES[`ALL ${r.pattern}`];
        const canon = await raw(port, method, url);
        asked++;
        // The canonical spelling: reached, or refused by the gate with the row's rule. Nothing else.
        if (profile === 'developer' || row.business === 'allow') {
          if (canon.status !== REACHED || canon.body?.reached !== r.pattern) wrong.push(`${method} ${url}: expected to reach ${r.pattern}, got ${canon.status} ${JSON.stringify(canon.body)}`);
        } else if (row.business === 'refuse') {
          if (canon.status !== 403 || canon.body?.rule !== row.rule) wrong.push(`${method} ${url}: expected 403 ${row.rule}, got ${canon.status} ${JSON.stringify(canon.body)}`);
        } else if (!(canon.status === REACHED && canon.body?.reached === r.pattern) && !(canon.status === 403 && canon.body?.rule === row.rule)) {
          wrong.push(`${method} ${url}: a checked row must reach its route or refuse with its rule, got ${canon.status} ${JSON.stringify(canon.body)}`);
        }
        for (const m of mutations(url, staticSegments(r.pattern))) {
          // The worker route is ONE route with two patterns (`…/worker` and `…/worker/*`): what follows
          // `/worker/` is the request to the plugin's worker, so those spellings are the same route by design.
          if (r.pattern.endsWith('/worker/*') && m.startsWith(`${url}/`)) continue;
          const got = await raw(port, method, m);
          asked++;
          // Never the route under test. It may be a different route (a static word read as a parameter of
          // another route): then THAT route's guard decided, and the answer names it.
          if (got.status === REACHED && got.body?.reached === r.pattern && r.pattern !== '(page)') {
            wrong.push(`${method} ${m} reached ${r.pattern} (canonical: ${url})`);
          }
          // A refused canonical spelling stays refused in every spelling: no 2xx from any route.
          if (profile === 'business' && canon.status === 403 && got.status === REACHED) {
            const other = BUSINESS_ROUTES[`${method} ${got.body?.reached}`];
            if (!other || other.business === 'refuse') wrong.push(`${method} ${m} got through to ${got.body?.reached}, which is refused`);
          }
          if (![REACHED, 400, 403, 404].includes(got.status)) wrong.push(`${method} ${m}: unexpected status ${got.status}`);
        }
      }
    }
    expect(wrong.slice(0, 25)).toEqual([]);
    expect(asked).toBeGreaterThan(5000);
  }, 180_000);

  test('the spellings the audit used are refused before any route', async () => {
    for (const [method, target] of [
      ['POST', '/api/sessions/p1/Terminals'], ['POST', '/API/sessions/p1/terminals'], ['POST', '/api//sessions/p1/terminals'],
      ['POST', '/api/Integrations'], ['POST', '/api/Agents/schedules'], ['POST', '/api/Plugins/install'], ['POST', '/api/Skills'],
      ['POST', '/api/terminals/p1/Input'], ['GET', '/api/terminals/p1/Scrollback'],
    ] as const) {
      const r = await raw(port, method, target);
      expect([400, 404], `${method} ${target} → ${r.status}`).toContain(r.status);
    }
  });
});

describe('WebSockets: the same table, the same spellings', () => {
  afterAll(() => closeKits());

  /** Ask for an upgrade with the path sent byte for byte; the answer is the HTTP status (101 = opened). */
  function upgrade(port: number, target: string): Promise<number> {
    return new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: target, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), Origin: `http://127.0.0.1:${port}` } });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 101); });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', () => resolve(0));
      req.end();
    });
  }
  const urlOf = (re: RegExp): string => re.source.replace(/^\^|\$$/g, '').replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, 'p1');

  test('the socket table is the whole list, and every row is anchored at both ends', () => {
    expect(SOCKET_ROUTES.map((s) => s.id).sort()).toEqual(['events', 'structured', 'terminal', 'terminal-legacy']);
    for (const s of SOCKET_ROUTES) { expect(s.path.source.startsWith('^')).toBe(true); expect(s.path.source.endsWith('$')).toBe(true); expect(s.path.flags).toBe(''); }
  });

  test.each(['business', 'developer'] as const)('%s: canonical paths follow the table; mutated paths never open a socket', async (profile) => {
    const k = build(profile);
    const port = await k.port();
    for (const s of SOCKET_ROUTES) {
      const url = urlOf(s.path);
      const status = await upgrade(port, url);
      if (profile === 'developer' || s.business === 'allow') expect(status, url).toBe(101);
      else expect(status, url).toBe(403);
      // With a query, as the page sends it.
      expect(await upgrade(port, `${url}?cols=80&rows=24`), `${url}?…`).toBe(status);
      const statics = url.split('/').map((seg, i) => (i > 0 && seg !== 'p1' ? i : -1)).filter((i) => i > 0);
      for (const m of [...mutations(url, statics), `/x${url}`, `${url}x`, `/prefix/..${url}`]) {
        const got = await upgrade(port, m);
        expect(got, `${m} (canonical ${url})`).not.toBe(101);
      }
    }
  }, 120_000);

  test('business: the chat stream of a thread that is not a chat thread stays closed', async () => {
    const k = build('business');
    const port = await k.port();
    const { v4: uuid } = await import('uuid');
    const sid = k.daemon.services.sessionService.create({ name: 'p', provider: 'claude-code', workingDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gate-proj-')) }).id;
    const add = (type: string, config: Record<string, unknown>): string => {
      const id = uuid();
      terminalsDb.create(k.db, { id, sessionId: sid, type, label: 't', config });
      return id;
    };
    const chat = add('claude-code', { transport: 'structured', approvals: 'smart' });
    const agent = add('claude-code', { transport: 'structured', role: 'agent' });
    const auto = add('claude-code', { transport: 'structured', approvals: 'auto' });
    expect(await upgrade(port, `/api/terminals/${chat}/structured-ws`)).toBe(101);
    expect(await upgrade(port, `/api/terminals/${agent}/structured-ws`)).toBe(403);
    expect(await upgrade(port, `/api/terminals/${auto}/structured-ws`)).toBe(403);
  });
});
