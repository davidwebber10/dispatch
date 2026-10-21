/**
 * Thread reports (spec 2026-10-13, section 6.4). A thread Chat started owes Chat one report
 * each time Chat sends it work (spawn_agent, message_thread). A live ending or question of a
 * Chat thread reports even when no report is owed (a watch woke it; the user steered it in the
 * thread), so Chat hears every turn. Pure helpers; the service logs.
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

/**
 * At start: what a pending report says now, or null while the thread can still settle on its own.
 * A thread that waits for an answer and whose interim report is logged (`waitingReported`) has
 * nothing new to say: its real ending reports.
 */
export function recoveryOutcome(t: { status: string; archived_at: string | null } | null, waitingReported = false): string | null {
  if (!t || t.archived_at) return 'gone';
  if (t.status === 'error') return 'error';
  if (t.status === 'needs_input') return waitingReported ? null : 'needs_input';
  if (t.status === 'waiting') return 'idle';
  return null; // working, queued, scheduled: the settle or error edge reports it
}

/** A pending prompt of a thread (SessionService.getPendingPermission): a question or a gated tool. */
export interface PendingPrompt { toolName?: string; input?: unknown; questions?: unknown[] }

/**
 * The text of what a waiting thread asks: each AskUserQuestion question with its options, or the
 * gated tool and its input. '' when there is no pending prompt (the thread asked in its text).
 */
export function pendingQuestionText(p: PendingPrompt | null | undefined): string {
  if (!p) return '';
  const qs = Array.isArray(p.questions) ? p.questions : [];
  if (qs.length) {
    return qs.map((raw) => {
      const q = (raw ?? {}) as { question?: unknown; header?: unknown; options?: unknown };
      const text = String(q.question ?? q.header ?? '').trim();
      const opts = Array.isArray(q.options)
        ? q.options.map((o: any) => (typeof o === 'string' ? o : String(o?.label ?? o?.name ?? ''))).filter(Boolean)
        : [];
      return opts.length ? `${text} (options: ${opts.join(' | ')})` : text;
    }).filter(Boolean).join('\n');
  }
  if (!p.toolName) return '';
  let input = '';
  try { input = p.input === undefined ? '' : JSON.stringify(p.input); } catch { input = ''; }
  return `permission to use ${p.toolName}${input && input !== '{}' ? `: ${input}` : ''}`;
}
