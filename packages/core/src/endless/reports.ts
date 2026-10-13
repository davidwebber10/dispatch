/**
 * Thread reports (spec 2026-10-13, section 6.4). A thread Chat started owes Chat one report
 * each time Chat sends it work (spawn_agent, message_thread). Pure helpers; the service logs.
 */

const NOTES: Record<string, string> = {
  needs_input: '(waiting for an answer) ',
  error: '(stopped with an error) ',
  gone: '(the thread is gone) ',
};

/**
 * `[Label] report: <output>`. Never clipped: only tool output is clipped; the log splits a
 * long report into consecutive messages (ruling, Task 6).
 */
export function reportText(label: string, outcome: string, output: string): string {
  const head = `[${label.trim().slice(0, 120) || 'thread'}] report: ${NOTES[outcome] ?? ''}`;
  return head + (output.trim() || '(no output)');
}

export function threadOrigin(t: { config: string | null }): string | null {
  try {
    const origin = JSON.parse(t.config || '{}')?.origin;
    return typeof origin === 'string' ? origin : null;
  } catch {
    return null;
  }
}

/** At start: what a pending report says now, or null while the thread can still settle on its own. */
export function recoveryOutcome(t: { status: string; archived_at: string | null } | null): string | null {
  if (!t || t.archived_at) return 'gone';
  if (t.status === 'error') return 'error';
  if (t.status === 'needs_input') return 'needs_input';
  if (t.status === 'waiting') return 'idle';
  return null; // working, queued, scheduled: the settle or error edge reports it
}
