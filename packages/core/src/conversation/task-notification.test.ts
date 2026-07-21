import { describe, it, expect } from 'vitest';
import {
  isTaskNotification, isTaskNotificationEntry, taskNotificationSummary,
  commandEchoSummary, isCommandEcho, classifyUserText, isInjectedUserEntry,
} from './task-notification';

// Captured verbatim from a real transcript line (origin.kind: 'task-notification').
const BODY = `<task-notification>
<task-id>bdjq1tq9y</task-id>
<tool-use-id>toolu_018vsfoazWVuehxP39QUHHSo</tool-use-id>
<output-file>/private/tmp/claude-501/tasks/bdjq1tq9y.output</output-file>
<status>completed</status>
<summary>Background command "Wait for the in-flight Agents deploy to finish" completed (exit code 0)</summary>
</task-notification>`;

const SUMMARY = 'Background command "Wait for the in-flight Agents deploy to finish" completed (exit code 0)';

describe('taskNotificationSummary', () => {
  it('extracts the summary, discarding the surrounding bookkeeping XML', () => {
    expect(taskNotificationSummary(BODY)).toBe(SUMMARY);
  });

  it('falls back to a generic label when <summary> is absent', () => {
    expect(taskNotificationSummary('<task-notification><status>failed</status></task-notification>'))
      .toBe('Background task finished');
  });

  it('returns undefined for an ordinary human turn', () => {
    expect(taskNotificationSummary('fix the tool row please')).toBeUndefined();
  });

  it('does not match a human turn that only quotes the tag', () => {
    expect(isTaskNotification('what is <task-notification> for?')).toBe(false);
    expect(isTaskNotification(`look:\n${BODY}`)).toBe(false);
  });
});

describe('isTaskNotificationEntry', () => {
  it('trusts the on-disk origin marker even without a parseable body', () => {
    expect(isTaskNotificationEntry({ origin: { kind: 'task-notification' }, message: { content: 'x' } })).toBe(true);
  });

  it('detects the string-content form', () => {
    expect(isTaskNotificationEntry({ message: { content: BODY } })).toBe(true);
  });

  it('detects the content-block form', () => {
    expect(isTaskNotificationEntry({ message: { content: [{ type: 'text', text: BODY }] } })).toBe(true);
  });

  it('leaves a real human turn alone in both forms', () => {
    expect(isTaskNotificationEntry({ message: { content: 'ship it' } })).toBe(false);
    expect(isTaskNotificationEntry({ message: { content: [{ type: 'text', text: 'ship it' }] } })).toBe(false);
  });

  it('does not classify a bare tool_result turn as a notification', () => {
    // No text blocks at all — `every` on an empty list is vacuously true, so this
    // guards the explicit length check that makes tool_result-only turns fall through.
    expect(isTaskNotificationEntry({ message: { content: [{ type: 'tool_result', content: 'out' }] } })).toBe(false);
  });
});

describe('commandEchoSummary', () => {
  it('pulls stdout out of a local-command echo (the exact bubble the bug showed)', () => {
    expect(commandEchoSummary('<local-command-stdout>Compacted </local-command-stdout>')).toBe('Compacted');
  });

  it('labels a bare invocation with the command name (+args)', () => {
    expect(commandEchoSummary('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>')).toBe('/compact');
  });

  it('prefers captured output over the invocation name when both are present', () => {
    expect(commandEchoSummary('<command-name>/compact</command-name><local-command-stdout>Compacted</local-command-stdout>')).toBe('Compacted');
  });

  it('returns "" (an echo with no readable text → drop) for an empty stdout', () => {
    expect(commandEchoSummary('<local-command-stdout></local-command-stdout>')).toBe('');
    expect(isCommandEcho('<local-command-stdout></local-command-stdout>')).toBe(true);
  });

  it('returns null for an ordinary human turn', () => {
    expect(commandEchoSummary('please run /compact when you get a chance')).toBeNull();
    expect(isCommandEcho('please run /compact when you get a chance')).toBe(false);
  });

  it('does not swallow a human turn that merely quotes a command tag mid-prose', () => {
    expect(commandEchoSummary('why does <local-command-stdout>x</local-command-stdout> show as my message?')).toBeNull();
  });
});

describe('classifyUserText', () => {
  it('demotes a task notification to a notice', () => {
    expect(classifyUserText(BODY)).toEqual({ kind: 'notice', text: SUMMARY });
  });
  it('demotes a command echo with output to a notice', () => {
    expect(classifyUserText('<local-command-stdout>Compacted</local-command-stdout>')).toEqual({ kind: 'notice', text: 'Compacted' });
  });
  it('drops a contentless command echo', () => {
    expect(classifyUserText('<command-args></command-args>')).toEqual({ kind: 'drop' });
  });
  it('leaves an ordinary turn as a user bubble', () => {
    expect(classifyUserText('ship it')).toEqual({ kind: 'user' });
  });
});

describe('isInjectedUserEntry', () => {
  it('covers task notifications and command echoes in both content forms', () => {
    expect(isInjectedUserEntry({ message: { content: BODY } })).toBe(true);
    expect(isInjectedUserEntry({ message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } })).toBe(true);
    expect(isInjectedUserEntry({ message: { content: [{ type: 'text', text: '<command-name>/compact</command-name>' }] } })).toBe(true);
  });
  it('leaves a real human turn alone', () => {
    expect(isInjectedUserEntry({ message: { content: 'ship it' } })).toBe(false);
  });
});
