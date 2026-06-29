// packages/core/tests/structured/fake-claude.mjs
// A stand-in for `claude` in stream-json mode: emits NDJSON events and reacts to
// stdin control_responses / user turns. Lets us test the manager hermetically.
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude', session_id: 'sess-fake', testEnv: process.env.DISPATCH_TEST_ENV ?? null });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'user') {
    const text = msg.message?.content ?? '';
    if (text === 'TRIGGER_PERMISSION') {
      // ask permission; wait for the control_response, then report it
      send({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'x.txt', content: 'hi' }, tool_use_id: 'tu-1' } });
      return;
    }
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo:' + text }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  } else if (msg.type === 'control_response') {
    const allowed = msg.response?.response?.behavior === 'allow';
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: allowed ? 'WROTE' : 'DENIED' }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  }
});
