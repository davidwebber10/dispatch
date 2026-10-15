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
// `-r gone-late-out`: like gone-late, but the helper holds only stdout (stderr closes at exit).
if (rIdx > -1 && process.argv[rIdx + 1] === 'gone-late-out') {
  const { spawn } = await import('node:child_process');
  const reason = 'No conversation found with session ID: gone-late-out';
  const frame = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'gone-late-out', errors: [reason] });
  process.stderr.write(reason + '\n');
  spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(frame + '\n')}), 200)`], { stdio: ['ignore', 'inherit', 'ignore'] });
  process.exit(1);
}
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
// The AskUserQuestion request this CLI is blocked on, if any (see TRIGGER_QUESTION).
let pendingQuestion = null;
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
      pendingQuestion = { request_id: 'req-2', tool_use_id: 'tu-2' };
      send({ type: 'control_request', request_id: 'req-2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Pick one', header: 'Choice', options: ['A', 'B'], multiSelect: false }] }, tool_use_id: 'tu-2' } });
      return;
    }
    if (typeof text === 'string' && text.startsWith('TRIGGER_BASH:')) {
      // A Bash tool call asking permission for the given command (the broad-kill guard tests).
      send({ type: 'control_request', request_id: 'req-bash', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: text.slice('TRIGGER_BASH:'.length) }, tool_use_id: 'tu-1' } });
      return;
    }
    if (text === 'TRIGGER_STALE_QUESTION') {
      // A question, then a turn end without an answer: a stale pending the manager must clear.
      send({ type: 'control_request', request_id: 'req-5', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Pick one', header: 'Choice', options: ['A', 'B'], multiSelect: false }] }, tool_use_id: 'tu-5' } });
      send({ type: 'result', subtype: 'success', is_error: false });
      return;
    }
    if (text === 'TRIGGER_STRAY_CANCEL') {
      // A cancel for a request that is not the pending one: must be ignored.
      send({ type: 'control_cancel_request', request_id: 'req-other' });
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
    if (msg.request?.subtype === 'interrupt' && pendingQuestion) {
      // Claude Code 2.1.296 on an interrupt while a question is up: cancel the pending request,
      // two is_error tool_results, then the turn's result. No control_response from us is needed.
      const q = pendingQuestion;
      pendingQuestion = null;
      send({ type: 'control_cancel_request', request_id: q.request_id });
      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: q.tool_use_id, is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed." }] } });
      send({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
      send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'tool_use' });
    }
  } else if (msg.type === 'control_response') {
    const r = msg.response?.response ?? {};
    if (pendingQuestion && msg.response?.request_id === pendingQuestion.request_id && r.behavior === 'deny') {
      // A deny's message becomes the question's is_error tool_result, verbatim (spike, 2.1.296).
      const q = pendingQuestion;
      pendingQuestion = null;
      send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: q.tool_use_id, is_error: true, content: r.message }] } });
      send({ type: 'result', subtype: 'success', is_error: false });
      return;
    }
    if (pendingQuestion && msg.response?.request_id === pendingQuestion.request_id) pendingQuestion = null;
    const allowed = r.behavior === 'allow';
    // Echo the resolved decision back so tests can assert the updatedInput / answers
    // map shape and the deny message the manager wrote.
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: allowed ? 'WROTE' : 'DENIED', updatedInput: r.updatedInput, message: r.message }] } });
    send({ type: 'result', subtype: 'success', is_error: false });
  }
});
