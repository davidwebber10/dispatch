// packages/core/tests/structured/fake-claude-two-requests.mjs
// A stand-in `claude` (stream-json) (subagents-v1 review, M3): after the first user message it sends TWO
// can_use_tool requests at once (two parallel subagents ask together), and logs each answer.
import readline from 'node:readline';
import fs from 'node:fs';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let started = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'user' && !started) {
    started = true;
    send({ type: 'system', subtype: 'init', model: 'fake', session_id: 's1', permissionMode: 'default' });
    send({ type: 'control_request', request_id: 'req-FRONT', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: process.env.FRONT_CMD }, tool_use_id: 'tu-front' } });
    send({ type: 'control_request', request_id: 'req-QUEUED', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: process.env.QUEUED_CMD }, tool_use_id: 'tu-queued' } });
    return;
  }
  if (m.type === 'control_response') { fs.appendFileSync(process.env.ANSWER_LOG, JSON.stringify(m.response) + '\n'); return; }
  if (m.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
});
