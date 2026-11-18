// packages/core/tests/structured/fake-claude-replay.mjs
// A stand-in for `claude` in stream-json mode that REPLAYS a recorded run (FAKE_CLAUDE_REPLAY = a
// .jsonl file under tests/fixtures/subagents/). The frames are the ones Claude Code itself wrote;
// this script only paces them the way the CLI would:
//   - nothing is sent before the first user message on stdin;
//   - a `can_use_tool` control request waits for the manager's control_response to it;
//   - a line `{"_await":"stop_task"}` waits for a `stop_task` control request, and the recorded
//     control_response that follows it is sent with the id of the request that came;
//   - a line with `_note` is a comment.
// After the last frame the process stays up (a live session), until stdin closes.
import readline from 'node:readline';
import fs from 'node:fs';

const file = process.env.FAKE_CLAUDE_REPLAY;
const frames = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((f) => !f._note);
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let i = 0;
let started = false;
let waitingFor = null; // { kind: 'permission', id } | { kind: 'stop_task' }
let stopRequestId = null;

function pump() {
  while (i < frames.length && !waitingFor) {
    const f = frames[i++];
    if (f._await) { waitingFor = { kind: f._await }; return; }
    if (f.type === 'control_response' && stopRequestId) {
      send({ ...f, response: { ...f.response, request_id: stopRequestId } });
      stopRequestId = null;
      continue;
    }
    send(f);
    if (f.type === 'control_request' && f.request?.subtype === 'can_use_tool') { waitingFor = { kind: 'permission', id: f.request_id }; return; }
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'user' && !started) { started = true; setImmediate(pump); return; }
  if (msg.type === 'control_response' && waitingFor?.kind === 'permission' && msg.response?.request_id === waitingFor.id) {
    waitingFor = null;
    setImmediate(pump);
    return;
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'stop_task' && waitingFor?.kind === 'stop_task') {
    stopRequestId = msg.request_id;
    waitingFor = null;
    setImmediate(pump);
    return;
  }
  // Any other control request (an interrupt, a stop_task that was not awaited): answered, no frames.
  if (msg.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
});
rl.on('close', () => process.exit(0));
