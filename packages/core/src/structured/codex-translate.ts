// packages/core/src/structured/codex-translate.ts
//
// The ONE place Codex `app-server` v2 JSON-RPC frames become the Claude-shaped event
// stream the ChatView + structured ws already consume (see useStructuredChat.ts). Keep
// ALL Codex⇄Claude mapping here so a protocol bump is a single-file fix — the manager
// (codex-manager.ts) is pure JSON-RPC plumbing and never inspects a Codex payload shape.
//
// Direction 1 (server → UI): `translate()` turns a Codex notification / ServerRequest into
//   an ordered list of TranslatedAction the manager enacts (push a Claude event to the ring,
//   emit 'session'/'busy'/'idle', or surface/auto-answer an approval).
// Direction 2 (UI → server): `buildApprovalResponse()` turns a Claude PermissionDecision back
//   into the Codex ReviewDecision-style response envelope the blocked ServerRequest awaits.
//
// Streaming: assistant text and reasoning are re-emitted as Anthropic `stream_event` frames
// (message_start / content_block_start|delta|stop) so the chat reveals tokens incrementally,
// exactly like the Claude structured path. Tool calls (command/file/mcp/…) are re-emitted as
// whole `assistant` tool_use + `user` tool_result pairs (the streaming reducer appends any
// tool it never saw start), and each turn ends with a synthetic `result` footer + 'idle'.

import type { PendingPermission, PermissionDecision } from './manager.js';

/** The four ServerRequest approval methods this layer understands (spec mapping table). */
export type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'item/tool/requestUserInput';

export const APPROVAL_METHODS: ReadonlySet<string> = new Set<ApprovalMethod>([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
]);

/** A Codex JSON-RPC frame the translator accepts (notification OR server→client request). */
export interface CodexFrame {
  method: string;
  params?: any;
  /** Present ⇒ a server→client request (must be answered); absent ⇒ a notification. */
  id?: string | number;
}

/** An action the manager enacts. Everything the translator wants to happen is expressed here
 *  so the manager stays protocol-agnostic. */
export type TranslatedAction =
  | { kind: 'event'; event: unknown } // push to the ring + emit 'event'
  | { kind: 'session'; sessionId: string } // emit 'session' (persist as terminal.external_id)
  | { kind: 'busy' } // emit 'busy' (a turn started)
  | { kind: 'idle' } // emit 'idle' (turn boundary)
  | {
      // A gated approval ServerRequest. The manager applies the escalate/auto-allow membrane:
      // surface it (set pending + emit 'permission') when supervised or `alwaysSurface`, else
      // auto-answer with `autoApprove`. Answering later runs through buildApprovalResponse.
      kind: 'approval';
      method: ApprovalMethod;
      requestId: string | number;
      pending: PendingPermission;
      alwaysSurface: boolean;
      autoApprove: unknown;
    };

/** Claude-shaped tool names for the Codex item variants (drives the tool card header). */
function toolNameForItem(item: any): string {
  switch (item?.type) {
    case 'commandExecution': return 'Shell';
    case 'fileChange': return 'ApplyPatch';
    case 'mcpToolCall': return `mcp:${item.server ?? '?'}/${item.tool ?? '?'}`;
    case 'dynamicToolCall': return String(item.tool ?? 'tool');
    case 'webSearch': return 'WebSearch';
    case 'imageGeneration': return 'ImageGeneration';
    default: return String(item?.type ?? 'tool');
  }
}

/** The tool_use `input` for an item — a readable summary the ToolCard renders. `file_path`
 *  is surfaced when known so the card shows a file chip (mirrors Claude's Read/Edit input). */
function toolInputForItem(item: any): Record<string, unknown> {
  switch (item?.type) {
    case 'commandExecution':
      return { command: item.command, cwd: item.cwd };
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const first = changes[0]?.path;
      return { ...(first ? { file_path: first } : {}), changes: changes.map((c: any) => ({ path: c.path, kind: c.kind?.type ?? c.kind, diff: c.diff })) };
    }
    case 'mcpToolCall': return { server: item.server, tool: item.tool, arguments: item.arguments };
    case 'dynamicToolCall': return { tool: item.tool, arguments: item.arguments };
    default: {
      const { id, type, ...rest } = item ?? {};
      return rest;
    }
  }
}

/** The tool_result body (stdout / applied-diff summary / mcp output) for a completed item. */
function toolOutputForItem(item: any): string {
  switch (item?.type) {
    case 'commandExecution':
      return typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return changes.map((c: any) => `${c.kind?.type ?? 'change'} ${c.path}\n${c.diff ?? ''}`).join('\n').trim() || 'Applied file change';
    }
    case 'mcpToolCall':
      if (item.error) return typeof item.error === 'string' ? item.error : JSON.stringify(item.error);
      return item.result != null ? JSON.stringify(item.result) : '';
    default:
      return '';
  }
}

/** Whether a completed item's status reads as a failure (drives tool_result.is_error). */
function itemIsError(item: any): boolean {
  const s = item?.status;
  if (typeof s === 'string') return /fail|declin|error|cancel/i.test(s);
  return item?.error != null || item?.success === false;
}

/** Item types handled as prose (streamed as stream_events) or synthesized elsewhere — NOT
 *  rendered as tool_use/tool_result pairs. */
const NON_TOOL_ITEMS = new Set(['agentMessage', 'reasoning', 'userMessage', 'hookPrompt', 'plan', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode']);

/**
 * Stateful per-thread translator. One instance per Codex terminal (the streaming block
 * indexing is per-turn state, so it can't be a free function). The manager owns the
 * instance and feeds it every inbound frame for that thread.
 */
export class CodexTranslator {
  private messageStarted = false; // stream_event message_start emitted for the current turn
  private nextBlockIndex = 0; // next Anthropic content-block index within the current turn
  private msgBlock = new Map<string, number>(); // agentMessage itemId → content-block index
  private reasoningBlock = new Map<string, number>(); // reasoning "itemId:contentIndex" → block index
  private turnCount = 0; // monotonic — only used to keep block keys unique across turns
  /** Item details cached from item/started so an approval ServerRequest (whose params omit
   *  the command/diff) can still show what's being approved. Keyed by Codex itemId. */
  private itemDetails = new Map<string, any>();
  private lastUsage: any = null; // most recent thread/tokenUsage/updated → result footer

  /** Emit a Claude `system/init` carrying the model, so the chat header shows it (parity with
   *  Claude's system/init). Called by the manager once thread/start|resume resolves. */
  init(model?: string): TranslatedAction[] {
    return [{ kind: 'event', event: { type: 'system', subtype: 'init', model } }];
  }

  /** Translate one inbound Codex frame into Claude-shaped actions. Unknown/noise frames → []. */
  translate(frame: CodexFrame): TranslatedAction[] {
    if (frame.id !== undefined && APPROVAL_METHODS.has(frame.method)) {
      return this.approval(frame.method as ApprovalMethod, frame.id, frame.params ?? {});
    }
    switch (frame.method) {
      case 'thread/started': return this.threadStarted(frame.params);
      case 'turn/started': return this.turnStarted();
      case 'turn/completed': return this.turnCompleted(frame.params);
      case 'item/agentMessage/delta': return this.agentDelta(frame.params);
      case 'item/reasoning/textDelta': return this.reasoningDelta(frame.params, `${frame.params?.itemId}:c${frame.params?.contentIndex ?? 0}`);
      case 'item/reasoning/summaryTextDelta': return this.reasoningDelta(frame.params, `${frame.params?.itemId}:s${frame.params?.summaryIndex ?? 0}`);
      case 'item/started': return this.itemStarted(frame.params?.item);
      case 'item/completed': return this.itemCompleted(frame.params?.item);
      case 'thread/tokenUsage/updated': return this.tokenUsage(frame.params);
      case 'error': return this.errorNotif(frame.params);
      default: return []; // account/*, mcpServer/*, skills/*, thread/status, turn/diff, … — ignored
    }
  }

  // --- server → UI -------------------------------------------------------------------------

  private threadStarted(params: any): TranslatedAction[] {
    const id = params?.thread?.id;
    return typeof id === 'string' && id ? [{ kind: 'session', sessionId: id }] : [];
  }

  private turnStarted(): TranslatedAction[] {
    // Reset per-turn streaming bookkeeping. message_start is emitted lazily at the first
    // streamed prose block (a tool-only turn needs none).
    this.messageStarted = false;
    this.nextBlockIndex = 0;
    this.msgBlock.clear();
    this.reasoningBlock.clear();
    return [{ kind: 'busy' }];
  }

  private turnCompleted(params: any): TranslatedAction[] {
    const turn = params?.turn ?? {};
    const usage = this.lastUsage?.last ?? this.lastUsage?.total;
    const result: Record<string, unknown> = {
      type: 'result',
      subtype: 'codex_turn',
      is_error: turn.status === 'failed',
      duration_ms: typeof turn.durationMs === 'number' ? turn.durationMs : undefined,
      usage: usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } : undefined,
    };
    return [{ kind: 'event', event: result }, { kind: 'idle' }];
  }

  /** Emit message_start once per turn (bumps the reducer's turn counter → fresh block keys). */
  private ensureMessageStart(out: TranslatedAction[]): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.turnCount += 1;
    out.push({ kind: 'event', event: { type: 'stream_event', event: { type: 'message_start' } } });
  }

  private agentDelta(params: any): TranslatedAction[] {
    const itemId = params?.itemId;
    const delta = params?.delta;
    if (typeof itemId !== 'string' || typeof delta !== 'string') return [];
    const out: TranslatedAction[] = [];
    this.ensureMessageStart(out);
    let index = this.msgBlock.get(itemId);
    if (index === undefined) {
      index = this.nextBlockIndex++;
      this.msgBlock.set(itemId, index);
      out.push({ kind: 'event', event: { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } } });
    }
    out.push({ kind: 'event', event: { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } } } });
    return out;
  }

  private reasoningDelta(params: any, key: string): TranslatedAction[] {
    const delta = params?.delta;
    if (typeof delta !== 'string') return [];
    const out: TranslatedAction[] = [];
    this.ensureMessageStart(out);
    let index = this.reasoningBlock.get(key);
    if (index === undefined) {
      index = this.nextBlockIndex++;
      this.reasoningBlock.set(key, index);
      out.push({ kind: 'event', event: { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } } } });
    }
    out.push({ kind: 'event', event: { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: delta } } } });
    return out;
  }

  private itemStarted(item: any): TranslatedAction[] {
    if (!item || typeof item.id !== 'string') return [];
    this.itemDetails.set(item.id, item); // remembered for a later approval ServerRequest
    if (NON_TOOL_ITEMS.has(item.type)) return []; // prose/echo handled via deltas / synthetic echo
    // A tool call: emit a whole `assistant` tool_use block. The streaming reducer appends any
    // tool whose id it hasn't seen (see useStructuredChat's whole-`assistant` handler).
    return [{
      kind: 'event',
      event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: item.id, name: toolNameForItem(item), input: toolInputForItem(item) }] } },
    }];
  }

  private itemCompleted(item: any): TranslatedAction[] {
    if (!item || typeof item.id !== 'string') return [];
    if (item.type === 'agentMessage') {
      // Close the streamed text block (harmless if never opened). Text itself already rendered
      // from deltas — do NOT re-emit it (the streaming reducer ignores whole-assistant text).
      const index = this.msgBlock.get(item.id);
      if (index === undefined) return [];
      return [{ kind: 'event', event: { type: 'stream_event', event: { type: 'content_block_stop', index } } }];
    }
    if (NON_TOOL_ITEMS.has(item.type)) return [];
    this.itemDetails.set(item.id, item);
    // Tool finished → emit the tool_result the reducer pairs with the tool_use above by id.
    return [{
      kind: 'event',
      event: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.id, content: toolOutputForItem(item), is_error: itemIsError(item) }] } },
    }];
  }

  private tokenUsage(params: any): TranslatedAction[] {
    const tu = params?.tokenUsage;
    if (!tu) return [];
    this.lastUsage = tu;
    const last = tu.last ?? tu.total;
    if (!last) return [];
    // A zero-content `assistant` event drives the chat's context-fill bar (its only source of
    // contextTokens). input_tokens carries non-cached; cache_read carries the cached slice.
    const nonCached = Math.max(0, (last.inputTokens ?? 0) - (last.cachedInputTokens ?? 0));
    return [{
      kind: 'event',
      event: { type: 'assistant', message: { role: 'assistant', content: [], usage: { input_tokens: nonCached, cache_read_input_tokens: last.cachedInputTokens ?? 0, output_tokens: last.outputTokens ?? 0 } } },
    }];
  }

  private errorNotif(params: any): TranslatedAction[] {
    const message = typeof params?.message === 'string' ? params.message : (typeof params === 'string' ? params : 'Codex error');
    return [
      { kind: 'event', event: { type: 'result', subtype: 'error', is_error: true, result: message } },
      { kind: 'idle' },
    ];
  }

  private approval(method: ApprovalMethod, requestId: string | number, params: any): TranslatedAction[] {
    const itemId = typeof params?.itemId === 'string' ? params.itemId : String(requestId);
    const cached = this.itemDetails.get(itemId);
    let pending: PendingPermission;
    let alwaysSurface = false;
    let autoApprove: unknown;
    switch (method) {
      case 'item/commandExecution/requestApproval':
        pending = { requestId: itemId, toolName: 'Shell', toolUseId: itemId, input: { command: params.command ?? cached?.command, cwd: params.cwd ?? cached?.cwd, reason: params.reason ?? undefined } };
        autoApprove = { decision: 'accept' };
        break;
      case 'item/fileChange/requestApproval': {
        const changes = Array.isArray(cached?.changes) ? cached.changes : [];
        const first = changes[0]?.path;
        pending = { requestId: itemId, toolName: 'ApplyPatch', toolUseId: itemId, input: { ...(first ? { file_path: first } : {}), reason: params.reason ?? undefined, changes: changes.map((c: any) => ({ path: c.path, kind: c.kind?.type ?? c.kind, diff: c.diff })) } };
        autoApprove = { decision: 'accept' };
        break;
      }
      case 'item/permissions/requestApproval':
        pending = { requestId: itemId, toolName: 'Permissions', toolUseId: itemId, input: { reason: params.reason ?? undefined, permissions: params.permissions, cwd: params.cwd } };
        autoApprove = { permissions: params.permissions ?? {}, scope: 'turn' };
        break;
      case 'item/tool/requestUserInput': {
        // The AskUserQuestion analogue — ALWAYS surfaces (can't be auto-answered; needs a real
        // choice). Questions are Claude-shaped (header/question/options) with the Codex option
        // `id` stashed so buildApprovalResponse can map the chosen text back to a Codex id.
        const questions = (Array.isArray(params.questions) ? params.questions : []).map((q: any) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          options: Array.isArray(q.options) ? q.options.map((o: any) => (typeof o === 'string' ? o : o.label)) : undefined,
        }));
        pending = { requestId: itemId, toolName: 'AskUserQuestion', toolUseId: itemId, input: { questions }, questions };
        alwaysSurface = true;
        autoApprove = { answers: {} };
        break;
      }
    }
    return [{ kind: 'approval', method, requestId, pending, alwaysSurface, autoApprove }];
  }
}

/**
 * Direction 2: turn a Claude PermissionDecision (the shape the service/UI produce) back into
 * the Codex response envelope the blocked ServerRequest awaits. Kept here so BOTH directions
 * of the mapping live in one file. `pending` carries the surfaced questions (with stashed
 * Codex option ids) for the requestUserInput answer mapping.
 */
export function buildApprovalResponse(method: ApprovalMethod, decision: PermissionDecision, pending: PendingPermission | null): unknown {
  const allow = decision.behavior === 'allow';
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { decision: allow ? 'accept' : 'decline' };
    case 'item/fileChange/requestApproval':
      return { decision: allow ? 'accept' : 'decline' };
    case 'item/permissions/requestApproval':
      // No "decline" variant exists — denial grants an empty profile (nothing extra).
      return allow ? { permissions: (pending?.input as any)?.permissions ?? {}, scope: 'turn' } : { permissions: {}, scope: 'turn' };
    case 'item/tool/requestUserInput': {
      if (!allow) return { answers: {} };
      const answersByText = (decision.updatedInput as any)?.answers ?? {};
      const questions = Array.isArray(pending?.questions) ? pending!.questions : [];
      const out: Record<string, { answers: string[] }> = {};
      for (const q of questions as any[]) {
        const value = answersByText[q?.question];
        if (q?.id && typeof value === 'string' && value) out[q.id] = { answers: [value] };
      }
      return { answers: out };
    }
  }
}
