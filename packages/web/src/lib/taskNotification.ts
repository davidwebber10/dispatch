/**
 * Claude Code reports a finished background task by injecting a `role: 'user'` turn whose
 * whole body is a `<task-notification>` XML block. It is NOT the human speaking — but unlike
 * the CLI's other injected context (loaded Skills, system reminders) it carries no `isMeta` /
 * `isSynthetic` flag, only an `origin.kind: 'task-notification'` field on the on-disk
 * transcript line. That field never survives into the live stream-json envelope or the
 * backfill events cc-sessions.ts rebuilds, so metadata alone can't catch every path.
 *
 * Detection is therefore by CONTENT SHAPE, which is identical on all three paths (live ws,
 * transcript backfill, REST page) and needs nothing threaded through the daemon. A human
 * turn that happens to *contain* the tag mid-prose is not one of these — the injected block
 * always occupies the entire message — so the match is anchored to the start and end.
 *
 * The core-side twin lives in packages/core/src/conversation/task-notification.ts. Duplicated
 * rather than shared because packages/web has no dependency on packages/core (ConvItem itself
 * is already declared independently in both); the shape is a fixed CLI output format, so the
 * two are not expected to drift.
 */

const BLOCK = /^\s*<task-notification>([\s\S]*)<\/task-notification>\s*$/;

export interface TaskNotification {
  /** The CLI's own one-line description, e.g. `Background command "…" completed (exit code 0)`. */
  summary: string;
  /** `completed`, `failed`, … — whatever the CLI wrote in <status>. Undefined if absent. */
  status?: string;
}

/**
 * Parse an injected task-notification body, or return null when `text` is an ordinary turn.
 *
 * Returns a notification (rather than a bare boolean) so callers can render the ONE
 * human-readable field — <summary> — instead of the raw XML. When <summary> is missing
 * (older CLI builds wrote only <status>) we fall back to a generic label rather than
 * returning null: the turn is still an injection and must not render as a user bubble.
 */
export function parseTaskNotification(text: string): TaskNotification | null {
  const m = BLOCK.exec(text);
  if (!m) return null;
  const body = m[1];
  const summary = tag(body, 'summary');
  const status = tag(body, 'status');
  return { summary: summary || 'Background task finished', ...(status ? { status } : {}) };
}

function tag(body: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? m[1].trim() || undefined : undefined;
}

/**
 * Running a slash command (/compact, /clear, a custom command) makes Claude Code write a
 * `role: 'user'` turn whose whole body is command bookkeeping — the invocation wrapper
 * (<command-name>/<command-message>/<command-args>/<command-contents>) and/or the captured
 * output (<local-command-stdout>/<local-command-stderr>). Like a task-notification it is NOT
 * the human speaking and carries no isMeta flag, so it otherwise renders as a user bubble full
 * of raw XML (e.g. `<local-command-stdout>Compacted</local-command-stdout>`). Mirror of the
 * core twin (packages/core/src/conversation/task-notification.ts).
 */
const CMD_TAGS = ['command-name', 'command-message', 'command-args', 'command-contents', 'local-command-stdout', 'local-command-stderr'] as const;
const CMD_BLOCK_G = new RegExp(`<(${CMD_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g');
const HAS_CMD_TAG = new RegExp(`<(${CMD_TAGS.join('|')})>`);

/** The short label for a slash-command echo (`text` may be `''` → render nothing), or null
 *  for an ordinary turn. Prefers captured output, else the invocation name/args. Anchored to
 *  the WHOLE message, so a human quoting one of the tags mid-prose keeps their bubble. */
export function parseCommandEcho(text: string): { text: string } | null {
  if (!HAS_CMD_TAG.test(text)) return null;
  if (text.replace(CMD_BLOCK_G, '').trim() !== '') return null; // real prose alongside → human turn
  const summary = (tag(text, 'local-command-stdout') || tag(text, 'local-command-stderr')
    || [tag(text, 'command-name'), tag(text, 'command-args')].filter(Boolean).join(' ') || '')
    .replace(/\s+/g, ' ').trim();
  return { text: summary };
}

/** Classify one `user`-role text body for the chat renderer: an ordinary turn, an injected
 *  event to show as a muted 'notice' (task-notification summary or command-echo label), or a
 *  'drop' (injected bookkeeping with no readable text). */
export type UserTextClass = { kind: 'user' } | { kind: 'notice'; text: string } | { kind: 'drop' };
export function classifyUserText(text: string): UserTextClass {
  const note = parseTaskNotification(text);
  if (note) return { kind: 'notice', text: note.summary };
  const echo = parseCommandEcho(text);
  if (echo) return echo.text ? { kind: 'notice', text: echo.text } : { kind: 'drop' };
  return { kind: 'user' };
}
