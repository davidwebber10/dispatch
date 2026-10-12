// packages/core/tests/structured/fake-claude.mjs
// A stand-in for `claude` in stream-json mode: emits NDJSON events and reacts to
// stdin control_responses / user turns. Lets us test the manager hermetically.
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// `-r gone-session`: a resume whose transcript is gone. Mirrors Claude Code 2.1.296 exactly:
// no init frame, one error `result` with no `result` field and the reason in `errors[]`, the
// same text on stderr, exit code 1.
const rIdx = process.argv.indexOf('-r');
// `-r gone-late`: the same failure, but the error frame reaches stdout only AFTER this process
// has exited (a helper that inherited stdout writes it 200 ms later). Node fires the child's
// 'exit' first, so this pins that the manager still reads the late frame.
if (rIdx > -1 && process.argv[rIdx + 1] === 'gone-late') {
  const { spawn } = await import('node:child_process');
  const reason = 'No conversation found with session ID: gone-late';
  const frame = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'gone-late', errors: [reason] });
  spawn(process.execPath, ['-e', `setTimeout(() => { process.stderr.write(${JSON.stringify(reason + '\n')}); process.stdout.write(${JSON.stringify(frame + '\n')}); }, 200)`], { stdio: ['ignore', 'inherit', 'inherit'] });
  process.exit(1);
}
if (rIdx > -1 && process.argv[rIdx + 1] === 'gone-session') {
  const reason = 'No conversation found with session ID: gone-session';
  process.stderr.write(reason + '\n');
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'gone-session', errors: [reason] });
  process.exit(1);
}
// `argv` echoes the launch args so resume tests can assert `-r <id>` was applied.
send({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude', session_id: 'sess-fake', testEnv: process.env.DISPATCH_TEST_ENV ?? null, argv: process.argv.slice(2) });
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
    if (text === 'TRIGGER_QUESTION') {
      // AskUserQuestion arrives as a can_use_tool whose input carries questions[]
      send({ type: 'control_request', request_id: 'req-2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Pick one', header: 'Choice', options: ['A', 'B'], multiSelect: false }] }, tool_use_id: 'tu-2' } });
      return;
    }
    if (text === 'TRIGGER_SCHEDULE') {
      // A wake-scheduler tool call (ScheduleWakeup) — auto-allowed like any other
      // non-escalating tool; the generic control_response branch below reports it.
      send({ type: 'control_request', request_id: 'req-3', request: { subtype: 'can_use_tool', tool_name: 'ScheduleWakeup', input: { delaySeconds: 60, reason: 'watching CI run', prompt: 'continue' }, tool_use_id: 'tu-3' } });
      return;
    }
    if (text === 'TRIGGER_CRON') {
      // CronCreate — the OTHER wake-scheduler tool; unlike ScheduleWakeup it has no
      // `reason` field, just a cron expression.
      send({ type: 'control_request', request_id: 'req-4', request: { subtype: 'can_use_tool', tool_name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'poll' }, tool_use_id: 'tu-4' } });
      return;
    }
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo:' + text }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  } else if (msg.type === 'control_request') {
    // Echo client→CLI controls (e.g. interrupt) back so tests can assert the frame
    // the manager wrote to stdin (top-level request_id + request.subtype).
    send({ type: 'system', subtype: 'control_request_received', request_id: msg.request_id, request: msg.request });
  } else if (msg.type === 'control_response') {
    const r = msg.response?.response ?? {};
    const allowed = r.behavior === 'allow';
    // Echo the resolved decision back so tests can assert the updatedInput / answers
    // map shape and the deny message the manager wrote.
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: allowed ? 'WROTE' : 'DENIED', updatedInput: r.updatedInput, message: r.message }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  }
});
