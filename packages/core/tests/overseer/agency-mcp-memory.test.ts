import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { callTool, handleRequest, resetIdentityCache } from '../../src/overseer/agency-mcp.js';

/**
 * The three memory tools of the `dispatch` server, end to end against a real daemon (spec
 * 2026-11-17-memory-design.md, phase 1 checks): each call carries the thread's own key, and the
 * daemon decides the scope from the key.
 */
describe('memory tools in the dispatch MCP server', () => {
  const names = ['DISPATCH_API', 'DISPATCH_AUTH', 'DISPATCH_AUTH_FILE', 'DISPATCH_SESSION', 'DISPATCH_TERMINAL', 'DISPATCH_PORT', 'DISPATCH_MEMORY'];
  const saved: Record<string, string | undefined> = {};
  let db: Database.Database;
  let app: any;
  let server: http.Server;
  let tmp: string;

  const as = (terminalId: string, sessionId: string) => {
    process.env.DISPATCH_AUTH = app.locals.keys.mint({ kind: 'thread', terminalId }).key;
    process.env.DISPATCH_TERMINAL = terminalId;
    process.env.DISPATCH_SESSION = sessionId;
    resetIdentityCache();
  };
  const text = (r: { content: { type: string; text?: string }[] }) => r.content[0].text ?? '';
  const json = (r: { content: { type: string; text?: string }[] }) => JSON.parse(text(r));

  beforeEach(async () => {
    for (const n of names) { saved[n] = process.env[n]; delete process.env[n]; }
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-tools-'));
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    for (const id of ['A', 'B']) {
      fs.mkdirSync(path.join(tmp, id));
      sessionsDb.create(db, { id, provider: 'claude-code', name: `proj-${id}`, workingDir: path.join(tmp, id) });
    }
    terminalsDb.create(db, { id: 'claudeA', sessionId: 'A', type: 'claude-code', label: 'c', config: { transport: 'structured' } });
    terminalsDb.create(db, { id: 'codexA', sessionId: 'A', type: 'codex', label: 'x', config: { transport: 'structured' } });
    terminalsDb.create(db, { id: 'claudeB', sessionId: 'B', type: 'claude-code', label: 'b', config: { transport: 'structured' } });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    process.env.DISPATCH_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.DISPATCH_MEMORY = '1';
  });
  afterEach(() => {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
    resetIdentityCache();
  });

  it('are listed only with DISPATCH_MEMORY=1', async () => {
    const list = async () => ((await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as any).tools.map((t: any) => t.name);
    expect(await list()).toEqual(expect.arrayContaining(['memory_search', 'memory_read', 'remember']));
    delete process.env.DISPATCH_MEMORY;
    expect(await list()).not.toContain('remember');
    as('claudeA', 'A');
    expect(text(await callTool('remember', { text: 'x' }))).toMatch(/not available/);
  });

  it('a note written in a Claude Code thread is found by a Codex thread of the same project, and read under its page', async () => {
    as('claudeA', 'A');
    expect(json(await callTool('remember', { text: 'Integration tests need FOO=1.', about: 'testing' }))).toMatchObject({ saved: true, in: 'project' });
    as('codexA', 'A');
    const found = json(await callTool('memory_search', { query: 'integration foo' }));
    expect(found.results).toEqual([expect.objectContaining({ in: 'project', about: 'testing', snippet: expect.stringContaining('**Integration**') })]);
    // The page itself is the person's.
    await fetch(`${process.env.DISPATCH_API}/api/memory/pages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'project:A', slug: 'testing', body: 'Run the suite.' }) });
    const page = json(await callTool('memory_read', { slug: 'testing' }));
    expect(page).toMatchObject({ slug: 'testing', in: 'project', text: 'Run the suite.', changedBy: 'user' });
    expect(page.newerNotes.map((n: any) => n.text)).toEqual(['Integration tests need FOO=1.']);
    as('claudeB', 'B');
    expect(json(await callTool('memory_search', { query: 'integration' })).results).toEqual([]);
    expect(text(await callTool('memory_read', { slug: 'testing' }))).toMatch(/no page "testing"/);
  });

  it('an off-the-record thread cannot write a note: the tool says why', async () => {
    await fetch(`${process.env.DISPATCH_API}/api/memory/threads/claudeA`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offRecord: true }) });
    as('claudeA', 'A');
    const r = await callTool('remember', { text: 'secret plan' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Error: This thread is off the record: it cannot save to memory.');
  });
});
