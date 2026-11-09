// packages/core/tests/structured/fake-claude-stream.mjs
// A stand-in for `claude` in stream-json mode WITH partial messages: each reply is streamed the
// way Claude Code streams it (message_start with the message id, content_block_start, deltas, the
// whole `assistant` frame of the block, content_block_stop, message_delta, message_stop), and a
// `result` ends the turn. Used by the ring compaction tests, the ring perf script and the manual
// check of W2-D. fake-claude.mjs stays as it is: it sends whole frames only.
//
// A user text of `STREAM <messages> <deltas>` makes a turn of <messages> assistant messages; each
// has a text block of <deltas> deltas and a tool call with its result. `HANG <deltas>` streams a
// text block and stops before the whole frame (a turn in flight). Any other text gets one streamed
// reply, `echo:<text>`.
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const SESSION = process.env.FAKE_CLAUDE_SESSION || 'sess-stream';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const stream = (event, parent = null) => send({ type: 'stream_event', event, session_id: SESSION, parent_tool_use_id: parent, uuid: randomUUID() });
const whole = (id, block, parent = null) => send({
  type: 'assistant',
  message: { id, type: 'message', role: 'assistant', model: 'claude-fake-1', content: [block], usage: { input_tokens: 10, output_tokens: 5 } },
  parent_tool_use_id: parent, session_id: SESSION, uuid: randomUUID(),
});

let msgSeq = 0;
const WORDS = ['alpha ', 'bravo ', 'charlie ', 'delta ', 'echo ', 'foxtrot ', 'golf ', 'hotel '];

function textBlock(id, index, pieces, { finish = true } = {}) {
  stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  for (const p of pieces) stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: p } });
  if (!finish) return;
  whole(id, { type: 'text', text: pieces.join('') });
  stream({ type: 'content_block_stop', index });
}

function toolBlock(id, index, toolId) {
  const input = { command: `echo ${toolId}` };
  stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} } });
  stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  whole(id, { type: 'tool_use', id: toolId, name: 'Bash', input });
  stream({ type: 'content_block_stop', index });
}

function message(pieces, { tool = false, finish = true } = {}) {
  const id = `msg_fake_${++msgSeq}`;
  stream({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-fake-1', content: [] } });
  textBlock(id, 0, pieces, { finish });
  if (!finish) return;
  const toolId = `toolu_fake_${msgSeq}`;
  if (tool) toolBlock(id, 1, toolId);
  stream({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
  stream({ type: 'message_stop' });
  if (tool) send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `out ${toolId}` }] }, parent_tool_use_id: null, session_id: SESSION, uuid: randomUUID() });
}

const result = () => send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: 'ok', session_id: SESSION, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } });

send({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-fake-1', session_id: SESSION, tools: [], mcp_servers: [] });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: msg.request?.subtype === 'set_model' ? { model: msg.request.model } : {} } });
    return;
  }
  if (msg.type !== 'user') return;
  const content = msg.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '';
  send({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-fake-1', session_id: SESSION, tools: [], mcp_servers: [] });
  const many = /^STREAM (\d+) (\d+)$/.exec(text.trim());
  const hang = /^HANG (\d+)$/.exec(text.trim());
  if (many) {
    const [messages, deltas] = [Number(many[1]), Number(many[2])];
    for (let m = 0; m < messages; m++) message(Array.from({ length: deltas }, (_, i) => WORDS[(m + i) % WORDS.length]), { tool: m < messages - 1 });
    result();
  } else if (hang) {
    message(['done ', 'first.']);
    message(Array.from({ length: Number(hang[1]) }, (_, i) => WORDS[i % WORDS.length]), { finish: false });
  } else {
    const reply = `echo:${text}`;
    message(reply.match(/.{1,4}/gs) ?? [reply]);
    result();
  }
});
