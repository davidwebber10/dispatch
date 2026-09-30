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
const REQUEST_FAILED = 'Doppler request failed (network or client error)';

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

async function call(fetchFn: FetchLike, tool: string, args: Record<string, unknown> = {}, token = 'fake-token') {
  const server = new McpServer({ name: 'doppler', version: '0.1.0' });
  registerTools(server, createDopplerClient(token, fetchFn), { project: 'dispatch', config: 'dev', readOnly: false });
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

// Doppler's own text. A write answers with every secret in the config, and an error's
// `messages` can quote any value: another secret in the config, or a multiline value in
// its JSON-escaped form (which no redaction of the sent value would match).
const UPSTREAM_BODY = JSON.stringify({
  messages: ['Invalid value fake-existing-secret', 'Value "fake-line-one\\nfake-line-two" is not allowed'],
  success: false,
  secrets: { OTHER: { raw: 'fake-raw-other', computed: 'fake-computed-other', note: 'fake-note' } },
});
// Not JSON, and each makes JSON.parse quote its input in the error message.
const MALFORMED_BODIES = ['<html>fake-raw-other</html>', '{"secrets": fake-raw-other}'];

describe('doppler tools: no upstream text reaches the result', () => {
  test.each([
    [400, 'Doppler rejected the request'],
    [401, 'the token was rejected'],
    [403, 'the token was rejected'],
    [404, 'not found'],
    [422, 'Doppler rejected the request'],
    [429, 'rate limited'],
    [500, 'the service is unavailable'],
    [502, 'the service is unavailable'],
  ])('status %i: every tool gives the status and "%s", never the body or its messages', async (status, category) => {
    for (const [tool, args] of TOOLS) {
      for (const body of [UPSTREAM_BODY, ...MALFORMED_BODIES]) {
        const { result, text } = await call(fakeFetch(status, body).fetchFn, tool, args);
        expect(result.isError).toBe(true);
        expect(text).toBe(`Doppler ${status}: ${category}`);
        expect(JSON.stringify(result)).not.toMatch(LEAK);
      }
    }
  });

  test('set: an error that quotes a multiline value in its JSON-escaped form never reaches the result', async () => {
    const args = { name: 'API_KEY', value: 'fake-line-one\nfake-line-two' };
    const { result, text } = await call(fakeFetch(400, UPSTREAM_BODY).fetchFn, 'doppler_set_secret', args);
    expect(result.isError).toBe(true);
    expect(text).toBe('Doppler 400: Doppler rejected the request');
    expect(JSON.stringify(result)).not.toMatch(LEAK);
  });

  test.each([
    ['doppler_set_secret', SET_ARGS, 'updated'],
    ['doppler_delete_secret', { name: 'API_KEY' }, 'deleted'],
  ] as const)('%s: a success body is never read, even one that is not JSON', async (tool, args, action) => {
    for (const body of [UPSTREAM_BODY, ...MALFORMED_BODIES]) {
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

describe('doppler tools: no exception text reaches the result', () => {
  test.each(TOOLS)('%s: a thrown fetch error gives a fixed message', async (tool, args) => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND fake-host (fake-secret)');
    };
    const { result, text } = await call(fetchFn, tool, args);
    expect(result.isError).toBe(true);
    expect(text).toBe(REQUEST_FAILED);
    expect(JSON.stringify(result)).not.toMatch(LEAK);
  });

  // Node's fetch validates headers first and throws `Headers.append: "Bearer <token>" is an
  // invalid header value` — the whole token in the message. Building the Request here gives
  // the same exception without any network.
  test.each(TOOLS)('%s: a token with a line break never reaches the result', async (tool, args) => {
    const badToken = 'fake-token\ninvalid';
    const nodeLikeFetch: FetchLike = async (url, init) => {
      new Request(url, init);
      return new Response('{}');
    };
    expect(() => new Request('https://api.doppler.com/', { headers: { Authorization: `Bearer ${badToken}` } }))
      .toThrow(/fake-token/);
    const { result, text } = await call(nodeLikeFetch, tool, args, badToken);
    expect(result.isError).toBe(true);
    expect(text).toBe(REQUEST_FAILED);
    expect(JSON.stringify(result)).not.toMatch(LEAK);
  });

  test.each([
    ['doppler_list_secrets', {}],
    ['doppler_get_secret', { name: 'API_KEY' }],
  ])('%s: a body that fails to read gives a fixed message', async (tool, args) => {
    const fetchFn: FetchLike = async () =>
      new Response(new ReadableStream({ start: (c) => c.error(new Error('stream broke at fake-secret')) }));
    const { result, text } = await call(fetchFn, tool, args);
    expect(result.isError).toBe(true);
    expect(text).toBe(REQUEST_FAILED);
    expect(JSON.stringify(result)).not.toMatch(LEAK);
  });
});

// The live API's answer for one secret. A missing name still answers 200, with nulls.
const SECRET_BODY = JSON.stringify({
  name: 'API_KEY',
  value: {
    raw: 'fake-raw-${OTHER}', computed: 'fake-computed', note: 'fake-note',
    rawVisibility: 'masked', computedVisibility: 'masked',
    rawValueType: { type: 'string' }, computedValueType: { type: 'string' },
  },
  success: true,
});
const MISSING_BODY = JSON.stringify({
  name: 'API_KEY',
  value: {
    raw: null, computed: null, note: null, rawVisibility: null, computedVisibility: null,
    rawValueType: null, computedValueType: null,
  },
  success: true,
});

describe('doppler_get_secret: facts by default, the value only on reveal', () => {
  test('without reveal it says the secret exists, with its length and type, and no value', async () => {
    const { result, text } = await call(fakeFetch(200, SECRET_BODY).fetchFn, 'doppler_get_secret', { name: 'API_KEY' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toEqual({
      project: 'dispatch', config: 'dev', name: 'API_KEY', exists: true, length: 'fake-computed'.length, type: 'string',
    });
    expect(JSON.stringify(result)).not.toMatch(LEAK);
  });

  test('reveal: false is the same as no reveal', async () => {
    const { text } = await call(fakeFetch(200, SECRET_BODY).fetchFn, 'doppler_get_secret', { name: 'API_KEY', reveal: false });
    expect(text).not.toMatch(LEAK);
    expect(JSON.parse(text).exists).toBe(true);
  });

  test('a missing secret (200 with nulls) is exists: false, not an error', async () => {
    for (const reveal of [false, true]) {
      const { result, text } = await call(fakeFetch(200, MISSING_BODY).fetchFn, 'doppler_get_secret', { name: 'API_KEY', reveal });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(text)).toEqual({ project: 'dispatch', config: 'dev', name: 'API_KEY', exists: false });
    }
  });

  test('reveal: true returns the computed value only — not the raw template or the note', async () => {
    const { result, text } = await call(fakeFetch(200, SECRET_BODY).fetchFn, 'doppler_get_secret', { name: 'API_KEY', reveal: true });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toEqual({ project: 'dispatch', config: 'dev', name: 'API_KEY', exists: true, value: 'fake-computed' });
    expect(text).not.toMatch(/fake-raw|fake-note/);
  });

  test('an empty secret exists with length 0', async () => {
    const body = JSON.stringify({ name: 'API_KEY', value: { raw: '', computed: '', computedValueType: { type: 'string' } } });
    const { text } = await call(fakeFetch(200, body).fetchFn, 'doppler_get_secret', { name: 'API_KEY' });
    expect(JSON.parse(text)).toEqual({ project: 'dispatch', config: 'dev', name: 'API_KEY', exists: true, length: 0, type: 'string' });
  });

  test('the description tells the agent to prefer doppler run and to reveal only when asked', async () => {
    const server = new McpServer({ name: 'doppler', version: '0.1.0' });
    registerTools(server, createDopplerClient('fake-token', fakeFetch(200, '{}').fetchFn), { project: 'dispatch', config: 'dev', readOnly: false });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();
    await client.close();
    const get = tools.find((t) => t.name === 'doppler_get_secret')!;
    expect(get.description).toMatch(/doppler run/);
    expect(get.description).toMatch(/reveal/);
    expect(get.description).toMatch(/only when the user asks/);
    expect(Object.keys((get.inputSchema as { properties: object }).properties)).toContain('reveal');
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
