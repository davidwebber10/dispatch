import { describe, expect, test } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDopplerClient, type FetchLike } from '../src/doppler-client.js';
import { registerTools } from '../src/tools.js';

// Tool results, errors included, land in the agent's transcript. These drive the real tool
// handlers over an in-memory MCP connection with a fake fetch (no network, no disk). Every
// fake secret, the token too, contains "fake", so one pattern catches a leak — including
// the truncated excerpt a JSON.parse error quotes (`"<html>fake"...`).
const LEAK = /fake/;

// Answers every request with the same status and body, and records each request's URL,
// method, and parsed JSON body.
function fakeFetch(status: number, body: string) {
  const requests: { url: string; method: string; body?: unknown }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(body, { status });
  };
  return { fetchFn, requests };
}

async function call(fetchFn: FetchLike, tool: string, args: Record<string, unknown> = {}) {
  const server = new McpServer({ name: 'doppler', version: '0.1.0' });
  registerTools(server, createDopplerClient('fake-token', fetchFn), { project: 'dispatch', config: 'dev', readOnly: false });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const result = await client.callTool({ name: tool, arguments: args });
  await client.close();
  return { result, text: (result.content as { text: string }[]).map((c) => c.text).join('\n') };
}

const SET_ARGS = { name: 'API_KEY', value: 'fake-sent-value' };
const TOOLS: [string, Record<string, unknown>][] = [
  ['doppler_list_secrets', {}],
  ['doppler_get_secret', { name: 'API_KEY' }],
  ['doppler_set_secret', SET_ARGS],
  ['doppler_delete_secret', { name: 'API_KEY' }],
];

// Doppler answers a write with every secret in the config; an error body could carry them too.
const VALUES_BODY = JSON.stringify({
  messages: ['Invalid request'],
  success: false,
  secrets: { OTHER: { raw: 'fake-raw-other', computed: 'fake-computed-other', note: 'fake-note' } },
});
// Not JSON, and each makes JSON.parse quote its input in the error message.
const MALFORMED_BODIES = ['<html>fake-raw-other</html>', '{"secrets": fake-raw-other}'];

describe('doppler tools: an upstream body never reaches the result', () => {
  test.each(TOOLS)('%s: an error gives the status and Doppler messages, not the body', async (tool, args) => {
    const { result, text } = await call(fakeFetch(400, VALUES_BODY).fetchFn, tool, args);
    expect(result.isError).toBe(true);
    expect(text).toBe('Doppler 400: Invalid request');
    expect(JSON.stringify(result)).not.toMatch(LEAK);
  });

  test.each(TOOLS)('%s: an error body that is not JSON gives the status only', async (tool, args) => {
    for (const body of MALFORMED_BODIES) {
      const { result, text } = await call(fakeFetch(502, body).fetchFn, tool, args);
      expect(result.isError).toBe(true);
      expect(text).toBe('Doppler 502');
      expect(JSON.stringify(result)).not.toMatch(LEAK);
    }
  });

  test('set: a Doppler message that quotes the sent value is redacted', async () => {
    const body = JSON.stringify({ messages: ['Value "fake-sent-value" is not allowed'], success: false });
    const { result, text } = await call(fakeFetch(400, body).fetchFn, 'doppler_set_secret', SET_ARGS);
    expect(result.isError).toBe(true);
    expect(text).toBe('Doppler 400: Value "[redacted]" is not allowed');
    expect(JSON.stringify(result)).not.toMatch(LEAK);
  });

  test.each([
    ['doppler_set_secret', SET_ARGS, 'updated'],
    ['doppler_delete_secret', { name: 'API_KEY' }, 'deleted'],
  ] as const)('%s: a success body is never read, even one that is not JSON', async (tool, args, action) => {
    for (const body of [VALUES_BODY, ...MALFORMED_BODIES]) {
      const { result, text } = await call(fakeFetch(200, body).fetchFn, tool, args);
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(text)).toEqual({ project: 'dispatch', config: 'dev', name: 'API_KEY', [action]: true });
      expect(JSON.stringify(result)).not.toMatch(LEAK);
    }
  });

  test.each([
    ['doppler_list_secrets', {}],
    ['doppler_get_secret', { name: 'API_KEY' }],
  ])('%s: a success body that is not JSON gives an error without its content', async (tool, args) => {
    for (const body of MALFORMED_BODIES) {
      const { result, text } = await call(fakeFetch(200, body).fetchFn, tool, args);
      expect(result.isError).toBe(true);
      expect(text).toBe('Doppler 200: the response is not valid JSON');
      expect(JSON.stringify(result)).not.toMatch(LEAK);
    }
  });
});

describe('doppler tools: the requests they send', () => {
  test('list asks the names endpoint and returns the names sorted', async () => {
    const { fetchFn, requests } = fakeFetch(200, JSON.stringify({ names: ['ZETA', 'ALPHA'], success: true }));
    const { result, text } = await call(fetchFn, 'doppler_list_secrets');
    expect(requests).toEqual([
      { url: 'https://api.doppler.com/v3/configs/config/secrets/names?project=dispatch&config=dev', method: 'GET' },
    ]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toEqual({ project: 'dispatch', config: 'dev', names: ['ALPHA', 'ZETA'] });
  });

  test('get asks for one secret by project, config, and name', async () => {
    const { fetchFn, requests } = fakeFetch(200, JSON.stringify({ name: 'API_KEY', value: { raw: 'x' } }));
    await call(fetchFn, 'doppler_get_secret', { name: 'API_KEY' });
    expect(requests).toEqual([
      { url: 'https://api.doppler.com/v3/configs/config/secret?project=dispatch&config=dev&name=API_KEY', method: 'GET' },
    ]);
  });

  test('set posts the one name and its value', async () => {
    const { fetchFn, requests } = fakeFetch(200, '{"success":true}');
    await call(fetchFn, 'doppler_set_secret', SET_ARGS);
    expect(requests).toEqual([
      {
        url: 'https://api.doppler.com/v3/configs/config/secrets',
        method: 'POST',
        body: { project: 'dispatch', config: 'dev', secrets: { API_KEY: 'fake-sent-value' } },
      },
    ]);
  });

  test('delete posts the one name with a null value', async () => {
    const { fetchFn, requests } = fakeFetch(200, '{"success":true}');
    await call(fetchFn, 'doppler_delete_secret', { name: 'API_KEY' });
    expect(requests).toEqual([
      {
        url: 'https://api.doppler.com/v3/configs/config/secrets',
        method: 'POST',
        body: { project: 'dispatch', config: 'dev', secrets: { API_KEY: null } },
      },
    ]);
  });
});
