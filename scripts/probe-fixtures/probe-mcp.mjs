#!/usr/bin/env node
// Probe fixture: a minimal stdio MCP server with one tool, `probe_call`.
// On each call it sends GET DISPATCH_API/probe/mcp with `Authorization: Bearer KEY`, where KEY
// comes from DISPATCH_AUTH, or from the file named by DISPATCH_AUTH_FILE. It never prints the key.
// PROBE_LABEL is a non-secret label of the thread that should own the key.
import fs from 'node:fs';
import readline from 'node:readline';

const api = process.env.DISPATCH_API || '';
const label = process.env.PROBE_LABEL || '';
const ownKey = () => process.env.DISPATCH_AUTH
  || (process.env.DISPATCH_AUTH_FILE ? fs.readFileSync(process.env.DISPATCH_AUTH_FILE, 'utf8').trim() : '');

const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');

async function probe() {
  if (!api) return 'no DISPATCH_API: nothing sent';
  const headers = { 'x-probe-src': 'mcp', 'x-probe-label': label };
  let key = '';
  try { key = ownKey(); } catch { /* unreadable key file: send no credential */ }
  if (key) headers.authorization = `Bearer ${key}`;
  try {
    const r = await fetch(`${api}/probe/mcp`, { headers, signal: AbortSignal.timeout(5000) });
    return `ok ${r.status}`;
  } catch (e) {
    return `error ${e?.name || 'fetch'}`;
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // a notification
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '0.0.0' } } });
      break;
    case 'tools/list':
      send({ id: msg.id, result: { tools: [{ name: 'probe_call', description: 'Probe call. Takes no input and answers ok.', inputSchema: { type: 'object', properties: {} } }] } });
      break;
    case 'tools/call': {
      const out = await probe();
      send({ id: msg.id, result: { content: [{ type: 'text', text: `ok (${out})` }] } });
      break;
    }
    case 'ping':
      send({ id: msg.id, result: {} });
      break;
    default:
      send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
rl.on('close', () => process.exit(0));
