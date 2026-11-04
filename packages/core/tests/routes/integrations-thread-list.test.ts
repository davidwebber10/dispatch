// A thread key may LIST integrations (values masked) so it can tell "I may add one" from "I may not see them".
// The owner sees every value. Export stays owner only. The refusal text names the method and the route.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { createIntegrationsRouter } from '../../src/routes/integrations.js';
import { IntegrationsService, maskIntegration, HIDDEN_VALUE, HIDDEN_PART } from '../../src/integrations/service.js';
import { createPrincipalMiddleware } from '../../src/auth/request-principal.js';
import { createKeyScope } from '../../src/auth/key-scope.js';
import { KeyRegistry } from '../../src/auth/principals.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import * as integrationsDb from '../../src/db/integrations.js';

const TOKEN = 'owner-access-token-for-the-test-0123456789';

function seed(db: Database.Database) {
  integrationsDb.create(db, {
    id: 'i1', name: 'linear', type: 'remote', url: 'https://mcp.example.com/sse?api_key=sk-live-1&mode=fast',
    headers: { Authorization: 'Bearer ${LINEAR_TOKEN}', 'X-Plain': 'literal-header-value' },
    env: { LINEAR_API_KEY: '${LINEAR_API_KEY}', REGION: 'us-east-1' },
  });
  integrationsDb.create(db, {
    id: 'i2', name: 'files', type: 'stdio', command: 'npx', args: ['-y', 'files-mcp'],
    env: { DB_PASSWORD: 'hunter2', MIXED: 'x-${PART}-y' },
  });
}

describe('GET /api/integrations for a thread key', () => {
  let db: Database.Database;
  let app: any;
  let key: string;

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'S', provider: 'claude-code', name: 's', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 'w', sessionId: 'S', type: 'claude-code', label: 'w', config: { transport: 'structured', role: 'agent' } });
    terminalsDb.create(db, { id: 'rr', sessionId: 'S', type: 'claude-code', label: 'rr', config: { transport: 'structured', role: 'agent', roleRun: 'nightly' } });
    seed(db);
    app = createApp({ db, skipPty: true });
    key = app.locals.keys.mint({ kind: 'thread', terminalId: 'w' }).key;
  });

  it('lists with every header and env value hidden, and shows ${NAME} references as they are', async () => {
    const res = await request(app).get('/api/integrations').set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(200);
    const [linear, files] = res.body.integrations;
    expect(linear.headers).toEqual({ Authorization: 'Bearer ${LINEAR_TOKEN}', 'X-Plain': HIDDEN_VALUE });
    expect(linear.env).toEqual({ LINEAR_API_KEY: '${LINEAR_API_KEY}', REGION: HIDDEN_VALUE });
    expect(files.env).toEqual({ DB_PASSWORD: HIDDEN_VALUE, MIXED: `${HIDDEN_PART}\${PART}${HIDDEN_PART}` });
    const text = JSON.stringify(res.body);
    for (const secret of ['literal-header-value', 'hunter2', 'us-east-1', 'sk-live-1']) expect(text).not.toContain(secret);
  });

  it('keeps names, types, command, args and enabled so the thread can see what is installed', async () => {
    const res = await request(app).get('/api/integrations').set('Authorization', `Bearer ${key}`);
    const files = res.body.integrations.find((i: any) => i.name === 'files');
    expect(files).toMatchObject({ id: 'i2', type: 'stdio', command: 'npx', args: ['-y', 'files-mcp'], enabled: true });
    const linear = res.body.integrations.find((i: any) => i.name === 'linear');
    expect(linear.url).toMatch(/^https:\/\/mcp\.example\.com\/sse/);
  });

  it('the list a thread key reads holds no secret from stdio args or a private url path; the owner and the stored row are unchanged', async () => {
    integrationsDb.create(db, {
      id: 'i3', name: 'remote-via-args', type: 'stdio', command: 'npx',
      args: ['-y', 'mcp-remote', 'https://host.example/mcp/private-token-1234', '--header', 'Authorization:Bearer sk-live-ARGSECRET'],
    });
    const res = await request(app).get('/api/integrations').set('Authorization', `Bearer ${key}`);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('sk-live-ARGSECRET');
    expect(text).not.toContain('private-token-1234');
    const open = await request(app).get('/api/integrations');
    expect(JSON.stringify(open.body)).toContain('sk-live-ARGSECRET');
    expect(integrationsDb.list(db).find((i) => i.id === 'i3')!.args[4]).toBe('Authorization:Bearer sk-live-ARGSECRET');
  });

  it('a credential-free local caller still sees every value (reads stay open)', async () => {
    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body.integrations[1].env.DB_PASSWORD).toBe('hunter2');
  });

  it('GET /export stays owner only for a thread key, and the message names the method and route', async () => {
    const res = await request(app).get('/api/integrations/export').set('Authorization', `Bearer ${key}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_only');
    expect(res.body.message).toContain('GET /api/integrations/export');
    expect(res.body.message).toMatch(/owner only/i);
    expect(res.body.message).toMatch(/only this route/i);
  });

  it('PATCH and DELETE stay owner only for a thread key, with their own method and route in the message', async () => {
    const patch = await request(app).patch('/api/integrations/i1').set('Authorization', `Bearer ${key}`).send({ enabled: false });
    expect(patch.status).toBe(403);
    expect(patch.body.error).toBe('owner_only');
    expect(patch.body.message).toContain('PATCH /api/integrations/i1');
    const del = await request(app).delete('/api/integrations/i1').set('Authorization', `Bearer ${key}`);
    expect(del.status).toBe(403);
    expect(del.body.message).toContain('DELETE /api/integrations/i1');
    expect(integrationsDb.list(db).length).toBe(2);
  });

  it('the refusal text in the message does not carry the key or the query string', async () => {
    const res = await request(app).get('/api/integrations/export?x=1').set('Authorization', `Bearer ${key}`);
    expect(res.body.message).not.toContain(key);
    expect(res.body.message).not.toContain('x=1');
  });

  it('a role run key is still refused on the list (only a plain thread key has the rule)', async () => {
    const rk = app.locals.keys.mint({ kind: 'thread', terminalId: 'rr' }).key;
    const res = await request(app).get('/api/integrations').set('Authorization', `Bearer ${rk}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_only');
  });

  it('a thread key can still add an integration (POST stays allowed)', async () => {
    const res = await request(app).post('/api/integrations').set('Authorization', `Bearer ${key}`)
      .send({ type: 'stdio', name: 'added', command: 'x' });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/integrations for the owner', () => {
  it('shows every value (access token)', async () => {
    const db = new Database(':memory:'); initSchema(db); seed(db);
    const reg = new KeyRegistry();
    const mini = express();
    mini.use(createPrincipalMiddleware({ registry: reg, scope: createKeyScope(db), getToken: () => TOKEN, via: 'test' }));
    mini.use(express.json());
    mini.use('/api/integrations', createIntegrationsRouter(new IntegrationsService(db)));
    const res = await request(mini).get('/api/integrations').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.integrations[1].env.DB_PASSWORD).toBe('hunter2');
    expect(res.body.integrations[0].headers['X-Plain']).toBe('literal-header-value');
  });
});

describe('maskIntegration: args, command and url paths (Codex P1 findings)', () => {
  const base = { id: 'i', name: 'n', type: 'stdio', url: null, headers: {}, env: {}, enabled: true, createdAt: '', updatedAt: '', createdBy: null } as const;
  const stdio = (args: string[], command = 'npx') => maskIntegration({ ...base, command, args } as any);

  it('hides the value of a header/secret flag, in both the next-arg and the --flag=value forms', () => {
    const out = stdio(['-y', 'mcp-remote@0.14.3', 'https://host.example/mcp', '--header', 'Authorization:Bearer sk-live-SECRET', '--api-key=abc123def456', '--token', 'tok_987654321']);
    const text = JSON.stringify(out.args);
    for (const secret of ['sk-live-SECRET', 'abc123def456', 'tok_987654321', 'Bearer']) expect(text).not.toContain(secret);
    expect(out.args).toEqual(['-y', 'mcp-remote@0.14.3', 'https://host.example/mcp', '--header', HIDDEN_VALUE, '--api-key=••••', '--token', HIDDEN_VALUE]);
  });
  it('hides a bare secret-looking argument and any other free text, and keeps flags, packages and ${NAME} refs', () => {
    const out = stdio(['@modelcontextprotocol/server-filesystem', '--port', '8080', 'sk-proj-AbC123xyz789QwErTy456', 'some free text', '${MY_TOKEN}']);
    expect(out.args).toEqual(['@modelcontextprotocol/server-filesystem', '--port', '8080', HIDDEN_VALUE, HIDDEN_VALUE, '${MY_TOKEN}']);
  });
  it('hides a command that holds a space or an = (an inline shell line)', () => {
    expect(stdio([], 'curl -H "Authorization: Bearer abc"').command).toBe(HIDDEN_VALUE);
    expect(stdio([], 'npx').command).toBe('npx');
    expect(stdio([], '/usr/local/bin/node').command).toBe('/usr/local/bin/node');
  });
  it('masks the url inside an argument', () => {
    const out = stdio(['mcp-remote', 'https://u:p@h.example/mcp/private-token-1234?key=zzz#frag']);
    expect(JSON.stringify(out.args)).not.toMatch(/private-token|zzz|frag|u:p/);
  });
  it('the url keeps scheme, host and known-safe path words; hides other path segments and the fragment', () => {
    const remote = (url: string) => maskIntegration({ ...base, type: 'remote', command: null, args: [], url } as any).url as string;
    const a = remote('https://host.example/mcp/private-token-1234/sse#frag');
    expect(a).not.toMatch(/private-token|frag/);
    expect(a).toMatch(/^https:\/\/host\.example\/mcp\/.*\/sse$/);
    expect(remote('https://mcp.linear.app/sse')).toBe('https://mcp.linear.app/sse');
    expect(remote('https://host.example/v1/mcp')).toBe('https://host.example/v1/mcp');
    expect(remote('https://host.example/')).toBe('https://host.example/');
  });
});

describe('maskIntegration', () => {
  it('hides a literal and keeps a pure or partial reference form per value', () => {
    const base = { id: 'i', name: 'n', type: 'remote', command: null, args: [], url: 'https://u.example/x', enabled: true, createdAt: '', updatedAt: '', createdBy: null } as const;
    const out = maskIntegration({ ...base, headers: { A: '${T}', B: 'plain', C: '' }, env: {} } as any);
    expect(out.headers).toEqual({ A: '${T}', B: HIDDEN_VALUE, C: HIDDEN_VALUE });
  });
  it('removes a user:password part and the query values of the url', () => {
    const base = { id: 'i', name: 'n', type: 'remote', command: null, args: [], headers: {}, env: {}, enabled: true, createdAt: '', updatedAt: '', createdBy: null } as const;
    const out = maskIntegration({ ...base, url: 'https://bob:pw@h.example/p?token=abc&b=2' } as any);
    expect(out.url).not.toMatch(/bob|pw@|abc|b=2/);
    expect(out.url).toMatch(/^https:\/\/h\.example\//);
  });
});
