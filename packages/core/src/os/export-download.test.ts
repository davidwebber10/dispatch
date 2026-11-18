import { afterEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyRegistry } from '../auth/principals.js';
import { createPrincipalMiddleware } from '../auth/request-principal.js';
import { nullKeyScope, type KeyScope } from '../auth/key-scope.js';
import { OsConnectionsProvider } from '../integrations/os-provider.js';
import { createOsToolsRouter } from './tools-proxy.js';
import { exportOf, failedNote, isExportPath, safeExportName, saveExport, savedNote, suffixedName, withSavedExport } from './export-download.js';

const dirs: string[] = [];
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const servers: http.Server[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.close();
});

const CSV = 'a,b\n1,2\n3,4\n';
const EXPORT = {
  os: 'export/v1', id: 'exp-123', marker: 'm', filename: 'Sales Report (Q3).csv', row_count: 2, truncated: false, cap: 300,
  columns: ['a', { name: 'b' }], sample_rows: [['1', '2']],
  download: { path: '/api/dispatch/exports/exp-123', auth: 'box-token' },
};
const csvResponse = (body = CSV, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/csv', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store', ...headers } });

function deps(fetchImpl: any, extra: Record<string, unknown> = {}) {
  return {
    osBaseUrl: () => 'https://os.internal',
    boxHeaders: () => ({ 'x-dispatch-box-token': 'box-secret', 'x-dispatch-owner': 'p@example.com' }),
    fetchImpl, privsep: null, scratchDir: tmp('exp-scratch-'), ...extra,
  };
}

describe('export names and paths', () => {
  test('a file name keeps only safe characters, the last path part and the extension', () => {
    expect(safeExportName('Sales Report (Q3).csv')).toBe('sales-report-q3.csv');
    expect(safeExportName('../../etc/passwd')).toBe('passwd');
    expect(safeExportName('..\\..\\x.CSV')).toBe('x.csv');
    expect(safeExportName('.hidden.csv')).toBe('hidden.csv');
    expect(safeExportName('', 'Exp_9')).toBe('export-exp_9.csv');
    expect(safeExportName(null)).toBe('export.csv');
    expect(safeExportName('..')).toBe('export.csv');
    const long = safeExportName(`${'x'.repeat(300)}.csv`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.csv')).toBe(true);
  });

  test('suffixes go before the extension', () => {
    expect(suffixedName('a.csv', 1)).toBe('a.csv');
    expect(suffixedName('a.csv', 2)).toBe('a-2.csv');
    expect(suffixedName('a', 3)).toBe('a-3');
  });

  test('only one segment below the export route is a download path', () => {
    expect(isExportPath('/api/dispatch/exports/exp-123')).toBe(true);
    expect(isExportPath('/api/dispatch/exports/')).toBe(false);
    expect(isExportPath('/api/dispatch/exports/../connections')).toBe(false);
    expect(isExportPath('/api/dispatch/exports/a/b')).toBe(false);
    expect(isExportPath('/api/dispatch/exports/a?x=1')).toBe(false);
    expect(isExportPath('/api/dispatch/connections')).toBe(false);
    expect(isExportPath('https://evil.example/api/dispatch/exports/a')).toBe(false);
    expect(isExportPath(42)).toBe(false);
  });

  test('exportOf finds the marker only', () => {
    expect(exportOf({ structuredContent: EXPORT })).toBe(EXPORT);
    expect(exportOf({ structuredContent: { os: 'other' } })).toBeNull();
    expect(exportOf({ content: [] })).toBeNull();
    expect(exportOf(null)).toBeNull();
  });

  test('the note names the file, the rows and the columns', () => {
    expect(savedNote('exports/x.csv', EXPORT)).toBe('Saved to exports/x.csv (2 rows; columns: a, b). Read it with code; do not paste it into the reply.');
    expect(savedNote('exports/x.csv', { row_count: null, columns: [] })).toBe('Saved to exports/x.csv (row count unknown). Read it with code; do not paste it into the reply.');
    expect(savedNote('exports/x.csv', { row_count: 300, truncated: true, cap: 300, columns: ['a'] })).toContain('the export stopped at its cap of 300 rows');
  });
});

describe('saveExport', () => {
  test('downloads with the box headers and the thread id, and writes exports/<name>, then -2, -3', async () => {
    const ws = tmp('exp-ws-');
    const fetchImpl = vi.fn(async () => csvResponse());
    const d = deps(fetchImpl);
    const a = await saveExport(d, EXPORT, ws, { 'x-dispatch-thread-id': 't-1' });
    expect(a).toMatchObject({ ok: true, relPath: 'exports/sales-report-q3.csv', bytes: CSV.length });
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe('https://os.internal/api/dispatch/exports/exp-123');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.headers['x-dispatch-box-token']).toBe('box-secret');
    expect(init.headers['x-dispatch-owner']).toBe('p@example.com');
    expect(init.headers['x-dispatch-thread-id']).toBe('t-1');
    expect(fs.readFileSync(path.join(ws, 'exports', 'sales-report-q3.csv'), 'utf8')).toBe(CSV);
    const b = await saveExport(d, EXPORT, ws);
    const c = await saveExport(d, EXPORT, ws);
    expect([b, c].map((r: any) => r.relPath)).toEqual(['exports/sales-report-q3-2.csv', 'exports/sales-report-q3-3.csv']);
    // The temporary files are gone.
    expect(fs.readdirSync(d.scratchDir as string)).toEqual([]);
  });

  test('refuses another auth or another path without a request', async () => {
    const fetchImpl = vi.fn();
    const ws = tmp('exp-ws-');
    expect(await saveExport(deps(fetchImpl), { ...EXPORT, download: { ...EXPORT.download, auth: 'bearer' } }, ws)).toMatchObject({ ok: false });
    expect(await saveExport(deps(fetchImpl), { ...EXPORT, download: { path: '/api/dispatch/connections', auth: 'box-token' } }, ws)).toMatchObject({ ok: false });
    expect(await saveExport(deps(fetchImpl), { ...EXPORT, download: { path: '//evil.example/api/dispatch/exports/x', auth: 'box-token' } }, ws)).toMatchObject({ ok: false });
    expect(await saveExport(deps(fetchImpl), EXPORT, null)).toMatchObject({ ok: false });
    expect(await saveExport(deps(fetchImpl, { osBaseUrl: () => null }), EXPORT, ws)).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ws, 'exports'))).toBe(false);
  });

  test('a base address with a path keeps the export route at the origin', async () => {
    const fetchImpl = vi.fn(async () => csvResponse());
    const r = await saveExport(deps(fetchImpl, { osBaseUrl: () => 'https://os.internal/' }), EXPORT, tmp('exp-ws-'));
    expect(r.ok).toBe(true);
    expect((fetchImpl.mock.calls[0] as any[])[0]).toBe('https://os.internal/api/dispatch/exports/exp-123');
  });

  test('the size cap: a declared length over it, and a streamed body over it, save nothing', async () => {
    const ws = tmp('exp-ws-');
    const big = 'x'.repeat(5000);
    const declared = await saveExport(deps(vi.fn(async () => csvResponse(big)), { maxBytes: 1000 }), EXPORT, ws);
    expect(declared).toMatchObject({ ok: false });
    expect((declared as any).reason).toMatch(/larger than the limit/);
    // No Content-Length: the stream is counted.
    const streamed = await saveExport(deps(vi.fn(async () => new Response(new Blob([big]).stream(), { status: 200 })), { maxBytes: 1000 }), EXPORT, ws);
    expect(streamed).toMatchObject({ ok: false });
    expect((streamed as any).reason).toMatch(/larger than the limit/);
    expect(fs.existsSync(path.join(ws, 'exports'))).toBe(false);
  });

  test('a 401 or a 404 is a short reason, and nothing is written', async () => {
    const ws = tmp('exp-ws-');
    expect(await saveExport(deps(vi.fn(async () => new Response('', { status: 404 }))), EXPORT, ws)).toEqual({ ok: false, reason: 'the export is gone or not yours' });
    expect(await saveExport(deps(vi.fn(async () => new Response('', { status: 401 }))), EXPORT, ws)).toEqual({ ok: false, reason: 'the box was not signed in' });
    expect(await saveExport(deps(vi.fn(async () => { throw new Error('ECONNREFUSED'); })), EXPORT, ws)).toEqual({ ok: false, reason: 'the download failed' });
    expect(fs.existsSync(path.join(ws, 'exports'))).toBe(false);
  });

  test('withSavedExport adds one text item; a failure keeps the result plus a note; another result is untouched', async () => {
    const ws = tmp('exp-ws-');
    const answer = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'sample' }], structuredContent: EXPORT } };
    const ok = await withSavedExport(deps(vi.fn(async () => csvResponse())), answer, ws);
    expect(ok.result.content).toEqual([{ type: 'text', text: 'sample' }, { type: 'text', text: savedNote('exports/sales-report-q3.csv', EXPORT) }]);
    expect(ok.result.structuredContent).toBe(EXPORT);
    const bad = await withSavedExport(deps(vi.fn(async () => new Response('', { status: 404 }))), answer, ws);
    expect(bad.result.content).toEqual([{ type: 'text', text: 'sample' }, { type: 'text', text: failedNote('the export is gone or not yours') }]);
    const plain = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'x' }] } };
    expect(await withSavedExport(deps(vi.fn()), plain, ws)).toBe(plain);
  });
});

describe('the company-tools route saves an export result', () => {
  const CONNECTIONS = { servers: [], env: {}, systemPrompt: null, entitled: ['data'], profile: 'business', osPublicUrl: 'https://os.example', osTools: { url: 'https://os.internal/api/dispatch/mcp' }, needsConsent: [] };
  const scope: KeyScope = { ...nullKeyScope, caller: (id) => ({ id, sessionId: 's1', type: 'claude-code', role: null, depth: 0, spawnedBy: null, origin: null, roleRun: false, archived: false, overseer: false }) };

  async function setup(workspace: string | null) {
    const calls: Array<[string, any]> = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      calls.push([String(url), init]);
      if (String(url).endsWith('/api/dispatch/connections')) return { ok: true, status: 200, json: async () => CONNECTIONS } as any;
      if (String(url).startsWith('https://os.internal/api/dispatch/exports/')) return csvResponse();
      const m = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'first rows' }], structuredContent: EXPORT } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const provider = new OsConnectionsProvider({ baseUrl: 'https://os.internal', boxToken: 'box-secret', ownerEmail: 'p@example.com', fetchImpl: fetchImpl as any, retryMinMs: 60_000 });
    await provider.refresh();
    const registry = new KeyRegistry();
    const app = express();
    app.use(express.json());
    app.use(createPrincipalMiddleware({ registry, scope }));
    app.use('/api', createOsToolsRouter({ provider, fetchImpl: fetchImpl as any, workspaceFor: () => workspace, exportScratchDir: tmp('exp-scratch-') }));
    const server = http.createServer(app); servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { key } = registry.mint({ kind: 'thread', terminalId: 't-7' });
    const call = async () => (await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/os/mcp/data`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query', arguments: { sql: 'select 1' } } }),
    })).json();
    return { calls, call, key };
  }

  test('the file lands in the workspace; the thread gets the note and never the box token', async () => {
    const ws = tmp('exp-ws-');
    const { calls, call, key } = await setup(ws);
    const body = await call();
    expect(body.result.content.at(-1).text).toBe(savedNote('exports/sales-report-q3.csv', EXPORT));
    expect(fs.readFileSync(path.join(ws, 'exports', 'sales-report-q3.csv'), 'utf8')).toBe(CSV);
    expect(JSON.stringify(body)).not.toContain('box-secret');
    const dl = calls.find(([u]) => u.includes('/api/dispatch/exports/'))!;
    expect(dl[1].headers['x-dispatch-box-token']).toBe('box-secret');
    expect(dl[1].headers['x-dispatch-thread-id']).toBe('t-7');
    expect(JSON.stringify(dl[1].headers)).not.toContain(key);
  });

  test('no workspace: the result is unchanged plus the note', async () => {
    const { call } = await setup(null);
    const body = await call();
    expect(body.result.content).toEqual([{ type: 'text', text: 'first rows' }, { type: 'text', text: failedNote('the thread has no workspace') }]);
  });
});
