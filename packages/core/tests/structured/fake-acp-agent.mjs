// packages/core/tests/structured/fake-acp-agent.mjs
// A stand-in for an ACP agent on stdio (`grok agent stdio`, `opencode acp`): just enough JSON-RPC
// for the ACP manager. Used by the journal tests and the manual check of W3-D.
//
// It keeps each session's turns in a JSON file (FAKE_ACP_STATE_DIR, default the system temp dir),
// so a `session/load` in a NEW process replays the history, as the real agents do.
//
// A prompt text of `TOOL <words>` adds a tool call with its result to the turn. `HANG <words>`
// streams the words and never ends the turn. Any other text gets a thought and a streamed reply,
// `echo:<text>`.
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const write = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
const MODEL = process.env.FAKE_ACP_MODEL || 'grok-fake-1';
const stateDir = process.env.FAKE_ACP_STATE_DIR || os.tmpdir();
const stateFile = (id) => path.join(stateDir, `fake-acp-${id}.json`);
const load = (id) => { try { return JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); } catch { return []; } };
const save = (id, turns) => { try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(stateFile(id), JSON.stringify(turns)); } catch { /* the test still runs */ } };

let sessionId = null;
let calls = 0;
const update = (u, meta) => notify('session/update', { sessionId, update: u, ...(meta ? { _meta: meta } : {}) });
const promptText = (prompt) => (Array.isArray(prompt) ? prompt.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : String(prompt ?? ''));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (msg.method === 'session/new') {
    sessionId = `sess-fake-${process.pid}-${Date.now()}`;
    return write({ jsonrpc: '2.0', id: msg.id, result: { sessionId, models: { currentModelId: MODEL } } });
  }
  if (msg.method === 'session/load') {
    sessionId = msg.params.sessionId;
    for (const turn of load(sessionId)) {
      update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: turn.user } }, { isReplay: true });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: turn.agent } }, { isReplay: true });
      notify('_x.ai/session/update', { sessionId, update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } }, _meta: { isReplay: true } });
    }
    return write({ jsonrpc: '2.0', id: msg.id, result: { models: { currentModelId: MODEL } } });
  }
  if (msg.method === 'session/prompt') {
    const text = promptText(msg.params?.prompt);
    const words = text.replace(/^(TOOL|HANG)\s*/, '');
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about ' } });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'it' } });
    if (text.startsWith('HANG')) {
      for (const w of words.split(' ')) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${w} ` } });
      return; // the turn stays open
    }
    if (text.startsWith('TOOL')) {
      const toolCallId = `call-${++calls}`;
      update({ sessionUpdate: 'tool_call', toolCallId, title: 'run_terminal_command', kind: 'execute', status: 'pending', rawInput: { command: `echo ${words}` } });
      update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { output: `${words}\n` }, content: [{ type: 'content', content: { type: 'text', text: `${words}\n` } }] });
    }
    const reply = `echo:${words}`;
    const half = Math.ceil(reply.length / 2);
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(0, half) } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.slice(half) } });
    save(sessionId, [...load(sessionId), { user: text, agent: reply }]);
    notify('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3, apiDurationMs: 5 } } });
    return write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
  if (msg.method === 'session/cancel') return;
  if (msg.id !== undefined && msg.method) return write({ jsonrpc: '2.0', id: msg.id, result: {} });
});
