// packages/core/tests/structured/fake-codex-loop-app-server.mjs
// A stand-in Codex app-server (subagents-v1 review, H2): a main agent that starts ONE subagent on every turn
// (a model that keeps delegating), and a subagent that ends 20 ms later. Frame shapes are the ones
// of the branch's own fake (tests/structured/fake-codex-app-server.mjs). It counts turn/start.
import readline from 'node:readline';
import fs from 'node:fs';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const THREAD = 'thread-loop';
let k = 0;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return respond(msg.id, { userAgent: 'fake', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: 'macos' });
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/start') {
    respond(msg.id, { thread: { id: THREAD, turns: [] }, model: 'gpt-fake' });
    notify('thread/started', { thread: { id: THREAD, sessionId: THREAD, turns: [] } });
    return;
  }
  if (msg.method === 'turn/start') {
    k += 1;
    const n = k;
    const turn = `turn-${n}`;
    const sub = `sub-${n}`;
    const text = (msg.params?.input ?? []).filter((i) => i.type === 'text').map((i) => i.text).join(' ');
    fs.appendFileSync(process.env.LOOP_LOG, JSON.stringify({ n, at: Date.now(), internal: text.startsWith('<task-notification>') }) + '\n');
    respond(msg.id, { turn: { id: turn, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
    notify('turn/started', { threadId: THREAD, turn: { id: turn, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD, turnId: turn, item: { type: 'subAgentActivity', id: `call-${n}`, kind: 'started', agentThreadId: sub, agentPath: `/root/task_${n}`, model: 'gpt-fake', reasoningEffort: 'low' } });
    notify('thread/started', { thread: { id: sub, sessionId: THREAD, parentThreadId: THREAD, turns: [] } });
    notify('item/completed', { threadId: THREAD, turnId: turn, item: { type: 'agentMessage', id: `m-${n}`, text: 'I started another agent.', phase: 'final_answer', memoryCitation: null } });
    notify('turn/completed', { threadId: THREAD, turn: { id: turn, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 3 } });
    setTimeout(() => {
      notify('turn/started', { threadId: sub, turn: { id: `s${turn}`, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
      notify('item/completed', { threadId: sub, turnId: `s${turn}`, item: { type: 'agentMessage', id: `sm-${n}`, text: 'Start one more agent for the next part.', phase: 'final_answer', memoryCitation: null } });
      notify('turn/completed', { threadId: sub, turn: { id: `s${turn}`, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 3 } });
    }, 20);
    return;
  }
  if (msg.id !== undefined && msg.method) respond(msg.id, {});
});
