// A stand-in `claude` that answers every user turn with a tool call (never a result).
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'system', subtype: 'init', session_id: 'sess-tool' });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== 'user') return;
  send({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/etc/hosts' } }] } });
});
