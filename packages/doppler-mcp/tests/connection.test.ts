import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDopplerClient, type FetchLike } from '../src/doppler-client.js';
import { registerTools } from '../src/tools.js';
import { resolveConnection } from '../src/connection.js';

// W1-C: the server reads the connection that the daemon saved, so no MCP config and no CLI
// environment has to carry the token. Every fake value contains "fake".
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doppler-mcp-conn-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const save = (c: Record<string, unknown>) => fs.writeFileSync(path.join(dir, 'doppler.json'), JSON.stringify(c), { mode: 0o600 });

describe('doppler-mcp connection', () => {
  test('with --secrets-dir it lists secret names with no DOPPLER_TOKEN in the environment', async () => {
    save({ token: 'fake-file-token', project: 'dispatch', config: 'dev', enabled: true, readOnly: true, tokenScope: 'opted-in' });
    const conn = resolveConnection(['--secrets-dir', dir], {});
    if (!conn.ok) throw new Error(conn.error);
    expect(conn).toMatchObject({ project: 'dispatch', config: 'dev', readOnly: true });

    const seen: { url: string; auth: string }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ secrets: { API_KEY: { raw: 'fake-value' }, DB_URL: { raw: 'fake-db' } } }), { status: 200 });
    };
    const server = new McpServer({ name: 'doppler', version: '0.1.0' });
    registerTools(server, createDopplerClient(conn.token, fetchFn), conn);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const result = await client.callTool({ name: 'doppler_list_secrets', arguments: {} });
    const tools = (await client.listTools()).tools.map((t) => t.name);
    await client.close();

    const text = (result.content as { text: string }[]).map((c) => c.text).join('\n');
    expect(text).toContain('API_KEY');
    expect(text).toContain('DB_URL');
    expect(text).not.toMatch(/fake/);
    expect(seen[0].auth).toBe('Bearer fake-file-token');
    expect(seen[0].url).toContain('project=dispatch');
    expect(seen[0].url).toContain('config=dev');
    // readOnly came from the file: the write tools are not registered.
    expect(tools).not.toContain('doppler_set_secret');
  });

  test('the file wins over the environment, and the environment fills what the file lacks', () => {
    save({ token: 'fake-file-token', project: 'dispatch', config: 'dev', readOnly: false });
    expect(resolveConnection(['--secrets-dir', dir], { DOPPLER_TOKEN: 'fake-env-token', DOPPLER_PROJECT: 'other', DOPPLER_CONFIG: 'prd', DOPPLER_READ_ONLY: '1' }))
      .toEqual({ ok: true, token: 'fake-file-token', project: 'dispatch', config: 'dev', readOnly: false });
    save({ project: 'dispatch', config: 'dev' });
    expect(resolveConnection(['--secrets-dir', dir], { DOPPLER_TOKEN: 'fake-env-token' }))
      .toMatchObject({ ok: true, token: 'fake-env-token', project: 'dispatch', config: 'dev' });
  });

  test('with no --secrets-dir the environment is the connection, as before', () => {
    expect(resolveConnection([], { DOPPLER_TOKEN: ' fake-env-token ', DOPPLER_PROJECT: 'p', DOPPLER_CONFIG: 'c', DOPPLER_READ_ONLY: '1' }))
      .toEqual({ ok: true, token: 'fake-env-token', project: 'p', config: 'c', readOnly: true });
    expect(resolveConnection([], {})).toEqual({ ok: false, error: 'DOPPLER_TOKEN is required' });
  });

  test('a problem is a fixed line that never quotes the token or the file', () => {
    expect(resolveConnection(['--secrets-dir'], {})).toEqual({ ok: false, error: 'usage: doppler-mcp [--secrets-dir <dir>]' });
    expect(resolveConnection(['--secrets-dir', path.join(dir, 'missing')], {}))
      .toEqual({ ok: false, error: 'no Doppler token: the saved connection has none and DOPPLER_TOKEN is not set' });
    fs.writeFileSync(path.join(dir, 'doppler.json'), '{"token": "fake-broken');
    const broken = resolveConnection(['--secrets-dir', dir], {});
    expect(broken).toEqual({ ok: false, error: 'no Doppler token: the saved connection has none and DOPPLER_TOKEN is not set' });
    save({ token: 'fake\ntoken', project: 'p', config: 'c' });
    const bad = resolveConnection(['--secrets-dir', dir], {});
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toMatch(/fake/);
  });

  test('a connection that the owner disabled is refused', () => {
    save({ token: 'fake-file-token', project: 'p', config: 'c', enabled: false });
    expect(resolveConnection(['--secrets-dir', dir], {})).toEqual({ ok: false, error: 'Doppler is turned off in Dispatch' });
  });
});
