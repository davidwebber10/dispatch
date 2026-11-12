#!/usr/bin/env node
// A scripted `claude -p --input-format stream-json` for the smart-approvals tests. It prints the
// frames measured on Claude Code 2.1.322 (2026-11-11): init with permissionMode, a classifier
// denial (system/permission_denied), and a can_use_tool forced by an `ask` rule.
import * as readline from 'node:readline';
const args = process.argv.slice(2);
const i = args.indexOf('--permission-mode');
// FAKE_NO_AUTO=1: this "model" has no auto mode; the CLI silently runs `default`.
let mode = process.env.FAKE_NO_AUTO === '1' ? 'default' : (i >= 0 ? args[i + 1] : 'default');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-haiku', permissionMode: mode });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request?.subtype === 'set_permission_mode') {
    if (m.request.mode === 'auto' && process.env.FAKE_NO_AUTO === '1') {
      out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'auto mode is not available for this model', error_code: 'auto_mode_model' } });
      return;
    }
    mode = m.request.mode;
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    out({ type: 'system', subtype: 'status', status: null, permissionMode: mode });
    return;
  }
  if (m.type === 'control_response') { out({ type: 'system', subtype: 'fake_answer', answer: m.response }); return; }
  if (m.type === 'user') {
    const text = typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content);
    out({ type: 'system', subtype: 'fake_user', text });
    if (text.includes('BLOCK')) {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'git push --force origin main' } }] } });
      out({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'toolu_9', decision_reason_type: 'classifier', decision_reason: '[Git Destructive]', message: 'Blocked by auto mode' });
      out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'chmod 777 x' }, tool_use_id: 'toolu_10', decision_reason_type: 'rule' } });
    }
  }
});
