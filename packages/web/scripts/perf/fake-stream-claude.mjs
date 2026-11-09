#!/usr/bin/env node
// packages/web/scripts/perf/fake-stream-claude.mjs
// A stand-in for `claude` in stream-json mode, for the browser measurements of load-perf.mjs
// (W2-E). It makes no model call. For each user turn it streams one long markdown reply
// (stream-fixture.mjs, about 4,000 tokens) as text deltas, 80 tokens a second, then the whole
// assistant message and the result. Put a `claude` file that runs this script first on the PATH of
// an ISOLATED daemon only.
import readline from 'node:readline';
import { streamDeltas, streamFixture } from './stream-fixture.mjs';

if (process.argv.includes('--version') || process.argv.includes('-v')) { console.log('2.1.309 (fake stream)'); process.exit(0); }
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const TOKEN_MS = Number(process.env.FAKE_STREAM_TOKEN_MS ?? 12.5);
let turn = 0;
send({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-fake-stream', session_id: 'sess-fake-stream' });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') { send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }); return; }
  if (msg.type !== 'user') return;
  turn += 1;
  const id = `msg-fake-${turn}`;
  const content = msg.message?.content;
  const asked = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => b?.text ?? '').join('') : '';
  // "short": a short reply, for a quick history. Any other text: the long reply.
  const text = /^short\b/i.test(asked) ? `Short reply ${turn}: **done**.\n\n\`\`\`ts\nconst n = ${turn};\n\`\`\`\n` : streamFixture();
  const deltas = streamDeltas(text);
  const ev = (event) => send({ type: 'stream_event', event, session_id: 'sess-fake-stream' });
  ev({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  let i = 0;
  const tick = setInterval(() => {
    if (i < deltas.length) { ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: deltas[i++] } }); return; }
    clearInterval(tick);
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'message_stop' });
    send({ type: 'assistant', uuid: `uuid-fake-${turn}`, session_id: 'sess-fake-stream', message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
    send({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-fake-stream', num_turns: turn, total_cost_usd: 0 });
  }, TOKEN_MS);
});
rl.on('close', () => process.exit(0));
