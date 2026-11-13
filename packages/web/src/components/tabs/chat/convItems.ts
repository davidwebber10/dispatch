import type { ConvItem } from '../../../api/types';
import { api } from '../../../api/client';
import { classifyUserText } from '../../../lib/taskNotification';
import { modelFromFrame } from '../../../lib/modelName';

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

/** What the timeline shows in the place of an image that the daemon's message journal could not keep. */
export const IMAGE_NOT_KEPT = 'Image not kept — too large';

/**
 * Turn an Anthropic-style image content block into an `'image'` ConvItem, or null if
 * `b` isn't an image. The source shapes:
 *   - inline base64 (`source.type === 'base64'`) → a `data:` URI (needs no session)
 *   - remote URL (`source.type === 'url'`)       → that URL verbatim
 *   - a local path/file ref                      → the sandboxed byte route via api.imageUrl
 *   - `source.type === 'journal_image'`          → the image route of the message journal: the
 *     item was over the journal's payload limit, so the daemon keeps the bytes outside it
 *   - `source.type === 'cut'`                    → no picture: the image was over the journal's
 *     image bound. The item has `imageNote` in the place of a URL, so the reader sees why.
 * The path case needs a `sessionId` to build the route; without one we skip it (the
 * data-URI / URL cases still parse, e.g. in unit tests with no session wired).
 */
export function imageItemFromBlock(b: any, sessionId?: string): ConvItem | null {
  if (!b || b.type !== 'image') return null;
  const alt = typeof b.alt === 'string' ? b.alt : (typeof b.title === 'string' ? b.title : undefined);
  const src = b.source ?? {};
  if (src.type === 'journal_image' && typeof src.id === 'string' && typeof src.thread === 'string') {
    return { kind: 'image', imageUrl: api.journalImageUrl(src.thread, src.id), imageMime: typeof src.media_type === 'string' ? src.media_type : undefined, imageAlt: alt };
  }
  if (src.type === 'cut') return { kind: 'image', imageNote: IMAGE_NOT_KEPT, imageAlt: alt };
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

/**
 * The items of a `system` event that the DAEMON wrote into a thread (not the CLI): a plain notice
 * (`dispatch_notice`, e.g. "Company tools are not reachable right now"). Null: not one of these.
 * The socket fold and the journal fold both call it, so the two render the same.
 */
export function daemonSystemItems(e: any): ConvItem[] | null {
  if (!e || e.type !== 'system') return null;
  if (e.subtype === 'dispatch_notice') {
    return typeof e.message === 'string' && e.message ? [{ kind: 'notice', text: e.message }] : [];
  }
  // A blocked action and its answer: the card above the composer shows them (ApprovalCards); the
  // timeline keeps one quiet line for the record.
  if (e.subtype === 'permission_blocked') {
    const b = e.block ?? {};
    return [{ kind: 'notice', text: `Blocked by the safety check: ${typeof b.title === 'string' ? b.title.replace(/^Wants to /, '') : 'an action'}${typeof b.detail === 'string' && b.detail ? ` (${b.detail.slice(0, 120)})` : ''}` }];
  }
  if (e.subtype === 'permission_blocked_resolved') {
    return [{ kind: 'notice', text: e.decision === 'allow' ? 'You allowed the blocked action.' : 'You kept the action blocked.' }];
  }
  return null;
}

/**
 * The timeline items of one WHOLE event (W3-D): a `user`, `assistant`, `result` or notice event as
 * the daemon's message journal keeps it. It is the fold that the chat socket applies to the same
 * event when no stream came before it (useChatSocket.ts), built with the same helpers, so an item
 * from the journal renders like the item from the socket (useChatHistory.test.ts keeps the two in
 * step). An event that renders nothing gives no item. With `seq`, each item carries it.
 */
export function itemsFromEvent(event: unknown, sessionId: string | undefined, seq?: number): ConvItem[] {
  const e = event as any;
  if (!e || typeof e !== 'object') return [];
  const out: ConvItem[] = [];
  if (e.type === 'system') {
    const own = daemonSystemItems(e);
    if (own) out.push(...own);
    else if (e.subtype === 'model') {
      const model = modelFromFrame(e);
      if (e.switched === true && model) out.push({ kind: 'system', systemKind: 'model', text: model });
    } else if (e.subtype === 'settings_refused') {
      out.push({ kind: 'result', isError: true, text: typeof e.message === 'string' && e.message ? e.message : 'The model or effort change was refused.' });
    } else if (e.subtype === 'spawn_error') {
      out.push({ kind: 'result', isError: true, text: `Could not start the thread: ${typeof e.message === 'string' && e.message ? e.message : 'unknown error'}` });
    }
  } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    const uuid = typeof e.uuid === 'string' ? e.uuid : undefined;
    for (const b of e.message.content) {
      if (!b) continue;
      if (b.type === 'text' && b.text) out.push({ kind: 'assistant', text: b.text, ...(uuid ? { uuid } : {}) });
      else if (b.type === 'thinking') out.push({ kind: 'thinking', text: b.thinking ?? b.text ?? '', ...(uuid ? { uuid } : {}) });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', toolName: b.name, toolId: b.id, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path, ...(uuid ? { uuid } : {}) });
      else if (b.type === 'image') { const img = imageItemFromBlock(b, sessionId); if (img) out.push(img); }
    }
  } else if (e.type === 'user' && e.message) {
    if (e.isSynthetic || e.isMeta) return [];
    const content = e.message.content;
    const source = e.meta?.source as ConvItem['source'] | undefined;
    const uuid = typeof e.uuid === 'string' ? e.uuid : undefined;
    if (typeof content === 'string') {
      if (content.trim()) { const it = userOrNotice(content, source, uuid); if (it) out.push(it); }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'tool_result') {
          out.push({ kind: 'tool-result', toolId: b.tool_use_id, text: flattenContent(b.content), isError: b.is_error === true, ...(uuid ? { uuid } : {}) });
          out.push(...imagesFromContent(b.content, sessionId));
        } else if (b.type === 'text' && b.text) {
          const it = userOrNotice(b.text, source, uuid);
          if (it) out.push(it);
        } else if (b.type === 'image') {
          const img = imageItemFromBlock(b, sessionId);
          if (img) out.push({ ...img, imageFromUser: true });
        }
      }
    }
  } else if (e.type === 'result') {
    if (e.subtype === 'backfill') return [];
    if (e.parent_tool_use_id != null) return []; // a subagent's turn end (subagents-v1) is not the thread's
    out.push({
      kind: 'result',
      isError: e.is_error === true,
      costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : undefined,
      turns: typeof e.num_turns === 'number' ? e.num_turns : undefined,
      durationMs: typeof e.duration_ms === 'number' ? e.duration_ms : undefined,
      tokensIn: e.usage?.input_tokens,
      tokensOut: e.usage?.output_tokens,
      text: e.is_error ? errorText(e) : undefined,
    });
  }
  return seq === undefined ? out : out.map((it) => ({ ...it, seq }));
}
