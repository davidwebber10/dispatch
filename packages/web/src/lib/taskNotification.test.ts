import { describe, it, expect } from 'vitest';
import { parseTaskNotification } from './taskNotification';

// The exact shape Claude Code injects (captured from a real transcript line —
// ~/.claude/projects/<enc-cwd>/<session>.jsonl, `origin.kind: 'task-notification'`).
const REAL = `<task-notification>
<task-id>bdjq1tq9y</task-id>
<tool-use-id>toolu_018vsfoazWVuehxP39QUHHSo</tool-use-id>
<output-file>/private/tmp/claude-501/-Users-davidwebber-Sites-explorer/7ff14008/tasks/bdjq1tq9y.output</output-file>
<status>completed</status>
<summary>Background command "Wait for the in-flight Agents deploy to finish" completed (exit code 0)</summary>
</task-notification>`;

describe('parseTaskNotification', () => {
  it('pulls the summary and status out of a real notification', () => {
    expect(parseTaskNotification(REAL)).toEqual({
      summary: 'Background command "Wait for the in-flight Agents deploy to finish" completed (exit code 0)',
      status: 'completed',
    });
  });

  it('tolerates surrounding whitespace (the CLI leaves a trailing newline)', () => {
    expect(parseTaskNotification(`\n${REAL}\n`)?.status).toBe('completed');
  });

  it('still reports an injection when <summary> is missing, so it never renders as a user bubble', () => {
    const r = parseTaskNotification('<task-notification><status>failed</status></task-notification>');
    expect(r).toEqual({ summary: 'Background task finished', status: 'failed' });
  });

  it('returns null for an ordinary human turn', () => {
    expect(parseTaskNotification('please fix the tool row truncation')).toBeNull();
  });

  it('does NOT swallow a human turn that merely quotes the tag mid-prose', () => {
    // Anchoring matters: a human asking about the format is a real turn and must
    // keep its bubble. Only a message that IS the block start-to-end is injected.
    expect(parseTaskNotification('why does <task-notification> show up as a user chat?')).toBeNull();
    expect(parseTaskNotification(`here is one:\n${REAL}`)).toBeNull();
  });
});
