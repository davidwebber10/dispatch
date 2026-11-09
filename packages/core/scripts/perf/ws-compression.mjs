// Perf check for W1-E item 2 (plan section 1A.3, "WebSocket compression").
// Sends the same replay frames (200 structured events) through a server made by createClientWss, with
// and without permessage-deflate, and sums the bytes that reach the client socket.
// Run:  node packages/core/scripts/perf/ws-compression.mjs
import http from 'node:http';
import { createRequire } from 'node:module';
import { createClientWss } from '../../dist/ws/client-wss.js';
const { WebSocket } = createRequire(import.meta.url)('ws');

const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(40);
const frames = [];
for (let i = 0; i < 100; i++) {
  frames.push(JSON.stringify({ type: 'user', uuid: `u-${i}`, message: { role: 'user', content: [{ type: 'text', text: `Question ${i}: ${filler.slice(0, 300)}` }] } }));
  frames.push(JSON.stringify({ type: 'assistant', uuid: `a-${i}`, message: { id: `msg-${i}`, role: 'assistant', model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: `Answer ${i}: ${filler}` }, { type: 'tool_use', id: `tool-${i}`, name: 'Read', input: { file_path: `/tmp/file-${i}.ts` } }],
    usage: { input_tokens: 100, output_tokens: 50 } } }));
}
const payloadBytes = frames.reduce((n, f) => n + Buffer.byteLength(f), 0);

async function run(label, wss) {
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => { for (const f of frames) ws.send(f); ws.close(); }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  let received = 0;
  let sock;
  ws.on('upgrade', (res) => { sock = res.socket; });
  ws.on('message', () => { received++; });
  await new Promise((r) => ws.on('close', r));
  const out = { label, extensions: ws.extensions || '(none)', framesReceived: received, payloadBytes, wireBytes: sock.bytesRead };
  server.close();
  return out;
}

// The second argument is ignored by the code before W1-E, so both rows are equal there.
const results = [
  await run('structured/events server (deflate asked)', createClientWss(undefined, { deflate: true })),
  await run('terminal server (no deflate)', createClientWss(undefined, { deflate: false })),
];
console.log(JSON.stringify(results, null, 2));
