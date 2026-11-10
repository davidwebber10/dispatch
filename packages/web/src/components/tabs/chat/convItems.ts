import type { ConvItem } from '../../../api/types';
import { api } from '../../../api/client';
import { classifyUserText } from '../../../lib/taskNotification';

// The pure helpers that turn the parts of a Claude-shaped event into timeline items. Moved out of
// useChatSocket.ts unchanged (W3-D, move-only), so the socket fold and the fold of the message
// journal (useChatHistory.ts) build an item with the same code.

export function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/** tool_result.content is frequently an array of blocks ([{type:'text',text}]) —
 * common for MCP tools and some built-ins — rather than a plain string. Flatten it
 * to text so the Output tab and rich tool views render readable content instead of
 * a raw JSON blob. Falls back to pretty JSON for any other (object) shape. */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('');
  }
  return safeJson(content);
}

/**
 * Turn an Anthropic-style image content block into an `'image'` ConvItem, or null if
 * `b` isn't an image. Three source shapes:
 *   - inline base64 (`source.type === 'base64'`) → a `data:` URI (needs no session)
 *   - remote URL (`source.type === 'url'`)       → that URL verbatim
 *   - a local path/file ref                      → the sandboxed byte route via api.imageUrl
 * The path case needs a `sessionId` to build the route; without one we skip it (the
 * data-URI / URL cases still parse, e.g. in unit tests with no session wired).
 */
export function imageItemFromBlock(b: any, sessionId?: string): ConvItem | null {
  if (!b || b.type !== 'image') return null;
  const alt = typeof b.alt === 'string' ? b.alt : (typeof b.title === 'string' ? b.title : undefined);
  const src = b.source ?? {};
  if (src.type === 'base64' && src.data) {
    const mime = src.media_type || 'image/png';
    return { kind: 'image', imageUrl: `data:${mime};base64,${src.data}`, imageMime: mime, imageAlt: alt };
  }
  if ((src.type === 'url' || src.type === 'uri') && (src.url || src.uri)) {
    return { kind: 'image', imageUrl: src.url || src.uri, imageAlt: alt };
  }
  // Path/file reference (various shapes the daemon may emit): resolve to the byte route.
  const path = src.path ?? src.file_path ?? b.path ?? b.file_path ?? (typeof src === 'string' ? src : undefined);
  if (path && sessionId) {
    return { kind: 'image', imageUrl: api.imageUrl(sessionId, path), imageAlt: alt };
  }
  return null;
}

/** Collect every image ConvItem inside a content array (e.g. a tool_result's blocks). */
export function imagesFromContent(content: unknown, sessionId?: string): ConvItem[] {
  if (!Array.isArray(content)) return [];
  const out: ConvItem[] = [];
  for (const b of content) {
    const img = imageItemFromBlock(b, sessionId);
    if (img) out.push(img);
  }
  return out;
}

/**
 * Build the timeline item for one `user`-role text body, or null when it should render
 * nothing (see classifyUserText).
 *
 * Claude Code writes two kinds of non-human turn on the SAME `role: 'user'` event path as the
 * human's own messages, with no `isMeta`/`isSynthetic` flag for the guard above to catch:
 * background-task completions (`<task-notification>`) and slash-command echoes (e.g.
 * `<local-command-stdout>Compacted</local-command-stdout>`). Both would otherwise render as a
 * right-aligned user bubble full of raw XML, so they're identified by content shape. A task
 * notification and a command echo WITH output are demoted to a muted 'notice' (the
 * notification is what CAUSES the assistant's next action; a `/compact` echo is a useful
 * "this happened here" marker); a contentless echo is dropped (null).
 */
export function userOrNotice(text: string, source: ConvItem['source'], uuid?: string): ConvItem | null {
  const c = classifyUserText(text);
  if (c.kind === 'drop') return null;
  if (c.kind === 'notice') return { kind: 'notice', text: c.text, ...(uuid ? { uuid } : {}) };
  return { kind: 'user', text, ...(source ? { source } : {}), ...(uuid ? { uuid } : {}) };
}

/** An error `result`'s reason: its `result` text, else Claude's `errors[]` (a failed resume, for
 *  example, has no `result` field and says why only there — #76). */
export function errorText(event: any): string | undefined {
  if (typeof event.result === 'string' && event.result) return event.result;
  const errors = Array.isArray(event.errors) ? event.errors.filter((e: unknown) => typeof e === 'string' && e) : [];
  return errors.length ? errors.join('\n') : undefined;
}
