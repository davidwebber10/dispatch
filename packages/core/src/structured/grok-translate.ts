// packages/core/src/structured/grok-translate.ts
//
// The ONE place Grok ACP frames (`grok agent stdio`, protocolVersion 1) become the
// Claude-shaped event stream the ChatView + structured ws already consume. Keep ALL
// Grok⇄Claude mapping here so a protocol bump is a single-file fix — the manager
// (grok-manager.ts) is pure JSON-RPC plumbing and never inspects an ACP payload shape.
//
// The frames themselves are documented by capture in grok-frames.fixture.ts. Three shapes
// matter beyond standard ACP:
//   - Grok wraps extensions in `_x.ai/*` methods, and a replayed session/load stream uses
//     `_x.ai/session/update` where the live stream uses `_x.ai/session_notification` for the
//     same updates — so routing is by `params.update.sessionUpdate`, NEVER by method.
//   - Unlike Codex item deltas, agent_message_chunk / agent_thought_chunk carry NO item id:
//     chunks accumulate into "the current block" and a block ends when a different kind of
//     content (thought↔text, a tool call) or the turn boundary arrives.
//   - `session/load` replays history as the SAME update kinds (whole-message chunks, tagged
//     `_meta.isReplay`); in replay mode the translator emits whole Claude events instead of
//     stream deltas — the reducer's non-streaming path — and NO control actions at all, so a
//     resume can never re-count usage or re-fire turn boundaries.

import type { PendingPermission, PermissionDecision } from './manager.js';
import { looksLikeQuestion } from '../status/question.js';

/** A Grok JSON-RPC frame (notification OR server→client request — `id` present ⇒ request). */
export interface GrokFrame {
  method: string;
  params?: any;
  id?: string | number;
}

/** An ACP permission option, stashed on the pending so the answer can map back to one. */
export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/** An action the manager enacts. Same contract as codex-translate's TranslatedAction, minus
 *  'session' (the ACP sessionId comes from the session/new|load RESPONSE, not a frame). */
export type GrokAction =
  | { kind: 'event'; event: unknown }
  | { kind: 'busy' }
  | { kind: 'idle'; summary?: string }
  | { kind: 'needs-help'; ask: string; summary: string }
  | {
      kind: 'approval';
      requestId: string | number;
      pending: PendingPermission;
      /** The ACP options, kept so answerPermission can map a decision to an optionId. */
      options: AcpPermissionOption[];
      alwaysSurface: boolean;
      autoApprove: unknown;
    };

export interface TranslateOpts {
  /** True while the manager is inside session/load — history replay, not a live turn. */
  replay?: boolean;
}

/**
 * Stateful per-terminal translator. One instance per Grok thread (the streaming block
 * bookkeeping is per-turn state). The manager owns the instance and feeds it every inbound
 * frame for that terminal's connection.
 */
export class GrokTranslator {
  private messageStarted = false; // stream_event message_start emitted for the current turn
  private nextBlockIndex = 0;
  /** The open streamed block, if any. Grok chunks carry no item id, so at most ONE block is
   *  open at a time and a change of content kind closes it. */
  private openBlock: { index: number; kind: 'text' | 'thinking' } | null = null;
  /** Prose accumulated into the CURRENT open text block. */
  private textAcc = '';
  /**
   * The full prose of the most recently completed text block this turn — the Grok analogue
   * of CodexTranslator.lastAgentText (see that doc comment): consumed once at the turn
   * boundary for the question heuristic + the persisted outcome line, then cleared so it can
   * never leak into the next turn.
   */
  private lastAgentText = '';
  /** tool_call ids whose tool_result has already been emitted (updates repeat per status). */
  private resultEmitted = new Set<string>();
  /** The ACP session's real model id (models.currentModelId), kept to stamp usage-bearing
   *  assistant frames — analytics takes a frame's `message.model` as AUTHORITATIVE
   *  (recorder.ts), and without it every Grok turn charts as "unknown". */
  private model?: string;

  /** Emit a Claude `system/init` carrying the model (parity with Claude's system/init).
   *  Called by the manager once session/new|load resolves with the current model id. */
  init(model?: string): GrokAction[] {
    this.model = model;
    return [{ kind: 'event', event: { type: 'system', subtype: 'init', model } }];
  }

  /** Translate one inbound frame. Unknown/noise frames → []. */
  translate(frame: GrokFrame, opts: TranslateOpts = {}): GrokAction[] {
    if (frame.id !== undefined && frame.method === 'session/request_permission') {
      return this.permission(frame.id, frame.params ?? {});
    }
    const update = frame.params?.update;
    const kind = update?.sessionUpdate;
    if (typeof kind !== 'string') return [];
    const replay = opts.replay === true;
    switch (kind) {
      case 'agent_message_chunk': return this.agentChunk(update, 'text', replay);
      case 'agent_thought_chunk': return this.agentChunk(update, 'thinking', replay);
      case 'user_message_chunk': return replay ? this.userReplay(update) : [];
      case 'tool_call': return this.toolCall(update);
      case 'tool_call_update': return this.toolCallUpdate(update);
      case 'turn_completed': return replay ? [] : this.turnCompleted(update);
      case 'response_completed': return replay ? [] : this.responseCompleted(update);
      case 'usage_update': return replay ? [] : this.usageUpdate(update);
      default: return []; // model_changed, available_commands_update, hook_execution, … — ignored
    }
  }

  // --- streamed prose ------------------------------------------------------------------------

  private agentChunk(update: any, blockKind: 'text' | 'thinking', replay: boolean): GrokAction[] {
    const text = update?.content?.text;
    if (typeof text !== 'string') return [];
    if (replay) {
      // Replay chunks are whole messages — emit a whole event for the reducer's plain path.
      const block = blockKind === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text };
      return [{ kind: 'event', event: { type: 'assistant', message: { role: 'assistant', content: [block] } } }];
    }
    const out: GrokAction[] = [];
    this.ensureMessageStart(out);
    if (this.openBlock && this.openBlock.kind !== blockKind) this.closeOpenBlock(out);
    if (!this.openBlock) {
      this.openBlock = { index: this.nextBlockIndex++, kind: blockKind };
      const content_block = blockKind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
      out.push({ kind: 'event', event: { type: 'stream_event', event: { type: 'content_block_start', index: this.openBlock.index, content_block } } });
    }
    const delta = blockKind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text };
    out.push({ kind: 'event', event: { type: 'stream_event', event: { type: 'content_block_delta', index: this.openBlock.index, delta } } });
    if (blockKind === 'text') this.textAcc += text;
    return out;
  }

  private ensureMessageStart(out: GrokAction[]): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    out.push({ kind: 'event', event: { type: 'stream_event', event: { type: 'message_start' } } });
  }

  /** Close the open streamed block, stashing completed prose for the turn boundary. */
  private closeOpenBlock(out: GrokAction[]): void {
    if (!this.openBlock) return;
    out.push({ kind: 'event', event: { type: 'stream_event', event: { type: 'content_block_stop', index: this.openBlock.index } } });
    if (this.openBlock.kind === 'text' && this.textAcc.trim()) this.lastAgentText = this.textAcc;
    this.textAcc = '';
    this.openBlock = null;
  }

  private userReplay(update: any): GrokAction[] {
    const text = update?.content?.text;
    if (typeof text !== 'string' || !text) return [];
    return [{ kind: 'event', event: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } } }];
  }

  // --- tools ---------------------------------------------------------------------------------

  private toolCall(update: any): GrokAction[] {
    const id = update?.toolCallId;
    if (typeof id !== 'string' || !id) return [];
    const out: GrokAction[] = [];
    this.closeOpenBlock(out); // a tool interrupts the prose — later prose starts a fresh block
    const name = update?._meta?.['x.ai/tool']?.name ?? update?.title ?? 'tool';
    this.toolNames.set(id, String(name));
    out.push({
      kind: 'event',
      event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: String(name), input: update?.rawInput ?? {} }] } },
    });
    return out;
  }

  private toolCallUpdate(update: any): GrokAction[] {
    const id = update?.toolCallId;
    const status = update?.status;
    if (typeof id !== 'string' || !id) return [];
    // OpenCode enriches a call's REAL input on in_progress updates — the initial tool_call
    // carries only scaffolding ({cwd}). Re-emit the whole tool_use with the same id: the
    // web's whole-assistant reconcile updates the existing row's input in place (matched by
    // tool id), so the Bash card shows the actual command instead of an empty input.
    if (status === 'in_progress' && update?.rawInput && !this.resultEmitted.has(id)) {
      // Progress frames repeat with the SAME rawInput several times per call (verified
      // live) — re-emit only when the input actually changed, or the ring carries three
      // identical copies of every tool_use.
      const serialized = JSON.stringify(update.rawInput);
      if (this.lastInputEmitted.get(id) === serialized) return [];
      this.lastInputEmitted.set(id, serialized);
      const name = this.toolNames.get(id) ?? update?.title ?? 'tool';
      return [{
        kind: 'event',
        event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: String(name), input: update.rawInput }] } },
      }];
    }
    if (status !== 'completed' && status !== 'failed') return []; // progress frames repeat per status
    if (this.resultEmitted.has(id)) return [];
    this.resultEmitted.add(id);
    return [{
      kind: 'event',
      event: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: toolOutput(update), is_error: status === 'failed' }] } },
    }];
  }

  /** tool_call id → name, for re-emitting an input-enriched tool_use (see toolCallUpdate). */
  private toolNames = new Map<string, string>();
  /** tool_call id → last emitted rawInput JSON, so repeated identical progress frames dedup. */
  private lastInputEmitted = new Map<string, string>();

  // --- turn boundary + usage -----------------------------------------------------------------

  private turnCompleted(update: any): GrokAction[] {
    const usage = update?.usage ?? {};
    return this.finishTurn({
      subtype: 'grok_turn',
      isError: update?.stop_reason === 'error' || update?.stop_reason === 'refusal',
      durationMs: typeof usage.apiDurationMs === 'number' ? usage.apiDurationMs : undefined,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    });
  }

  /**
   * The turn boundary driven by the session/prompt RESPONSE — OpenCode's ONLY boundary
   * (unlike Grok it sends no `turn_completed` update; the response's stopReason + usage are
   * where the turn ends). Called by the manager when the response resolves with the turn
   * still open, so on Grok it doubles as the cancel/protocol-error fallback — which now
   * settles with a real result footer instead of a bare idle.
   */
  promptResult(result: any): GrokAction[] {
    const usage = result?.usage ?? {};
    const stop = result?.stopReason ?? result?.stop_reason;
    return this.finishTurn({
      subtype: 'acp_turn',
      isError: stop === 'error' || stop === 'refusal',
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cachedReadTokens ?? 0,
      costUsd: this.takeCostDelta(),
      // The response's usage is the turn's BILLABLE record on OpenCode, whose
      // dialect has no response_completed. On Grok this path is only the
      // cancel/protocol-error fallback, and the per-call frames (when any came)
      // have already reported — finishTurn's usageReportedThisTurn guard keeps
      // those turns from double-counting.
      emitBillableUsage: true,
    });
  }

  /** Shared tail of every turn boundary: result footer, per-turn state reset, idle/needs-help. */
  private finishTurn(t: { subtype: string; isError: boolean; durationMs?: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; costUsd?: number; emitBillableUsage?: boolean }): GrokAction[] {
    const out: GrokAction[] = [];
    this.closeOpenBlock(out);
    // The BILLABLE per-turn usage, as a plain (untagged) assistant frame — the
    // one frame the recorder counts for an OpenCode turn. OpenCode reports usage
    // nowhere else analytics may read: usage_update is a context gauge (tagged
    // context_fill, skipped by frames.ts), and the result footer below is not a
    // message. Only promptResult opts in (emitBillableUsage), and only when NO
    // per-call response_completed frame already reported this turn's usage — on
    // Grok those frames are the record, and repeating their aggregate here would
    // double-count the turn. Grok's turn_completed path never opts in at all: its
    // aggregate can span several calls, and pushing it as an assistant frame
    // would also yank the web's context bar to a multi-call sum. `inputTokens`
    // here is already the NON-cached slice (cachedReadTokens is its own field),
    // so no subtraction happens — unlike responseCompleted, whose wire figure
    // merges the two.
    if (t.emitBillableUsage && !this.usageReportedThisTurn && (t.inputTokens || t.outputTokens || t.cacheReadTokens)) {
      out.push({
        kind: 'event',
        event: {
          type: 'assistant',
          message: {
            role: 'assistant',
            ...(this.model ? { model: this.model } : {}),
            content: [],
            usage: {
              input_tokens: t.inputTokens,
              cache_read_input_tokens: t.cacheReadTokens ?? 0,
              output_tokens: t.outputTokens,
            },
          },
        },
      });
    }
    out.push({
      kind: 'event',
      event: {
        type: 'result',
        subtype: t.subtype,
        is_error: t.isError,
        duration_ms: t.durationMs,
        usage: { input_tokens: t.inputTokens, output_tokens: t.outputTokens },
        ...(typeof t.costUsd === 'number' && t.costUsd > 0 ? { total_cost_usd: t.costUsd } : {}),
      },
    });
    // Read the closing prose ONCE, then clear it — a stale value would let a question from a
    // prior turn re-fire the heuristic (mirrors CodexTranslator.turnCompleted).
    const text = this.lastAgentText || this.textAcc;
    this.lastAgentText = '';
    // Reset per-turn streaming bookkeeping for the next turn.
    this.messageStarted = false;
    this.nextBlockIndex = 0;
    this.textAcc = '';
    this.usageReportedThisTurn = false;
    // `summary` is ALWAYS carried (even '') — its presence tells the idle listener "the agent
    // answered for this turn", never to fall back to the Claude ring walk (see the
    // wirePermissionMembrane idle handler's comment on Codex, which Grok shares).
    out.push(looksLikeQuestion(text) ? { kind: 'needs-help', ask: text, summary: text } : { kind: 'idle', summary: text });
    return out;
  }

  /**
   * OpenCode's `usage_update` — the context-fill signal: `used` tokens of a `size`-token
   * window, plus the session-cumulative dollar `cost`. Emits the same zero-content assistant
   * usage frame as responseCompleted, with the REAL window carried as `context_window` so the
   * web needs no per-model window table for open models.
   */
  private usageUpdate(update: any): GrokAction[] {
    const used = typeof update?.used === 'number' ? update.used : 0;
    const size = typeof update?.size === 'number' ? update.size : undefined;
    if (typeof update?.cost?.amount === 'number') this.cumulativeCostUsd = update.cost.amount;
    if (!used) return [];
    return [{
      kind: 'event',
      event: {
        type: 'assistant',
        // A GAUGE, not a bill: `used` is the whole current context, re-reported
        // on every publish. The tag makes analytics skip it (frames.ts); the web
        // reads it for the fill bar exactly as before and ignores the subtype.
        subtype: 'context_fill',
        ...(size ? { context_window: size } : {}),
        message: {
          role: 'assistant',
          ...(this.model ? { model: this.model } : {}),
          content: [],
          usage: { input_tokens: used, output_tokens: 0 },
        },
      },
    }];
  }

  /** True once a per-call response_completed frame reported usage for the CURRENT
   *  turn — the signal that the per-call frames are this turn's usage record and
   *  the boundary must not repeat their aggregate (see finishTurn). Grok sets it;
   *  OpenCode never does (its dialect has no response_completed). */
  private usageReportedThisTurn = false;

  /** Session-cumulative cost as last reported by usage_update; deltas are per-turn. */
  private cumulativeCostUsd = 0;
  private costReportedUsd = 0;
  private takeCostDelta(): number | undefined {
    const delta = this.cumulativeCostUsd - this.costReportedUsd;
    this.costReportedUsd = this.cumulativeCostUsd;
    return delta > 0 ? delta : undefined;
  }

  private responseCompleted(update: any): GrokAction[] {
    const u = update?.usage;
    if (!u) return [];
    this.usageReportedThisTurn = true;
    // A zero-content `assistant` event drives the chat's context-fill bar. ACP's
    // input_tokens is the WHOLE context of the model call (cache included), so the
    // non-cached slice is input minus cache_read — same convention as codex-translate.
    const cacheRead = u.cache_read_input_tokens ?? 0;
    return [{
      kind: 'event',
      event: {
        type: 'assistant',
        message: {
          role: 'assistant',
          // The real model id, so analytics groups these tokens under it (see `model` field).
          ...(this.model ? { model: this.model } : {}),
          content: [],
          usage: {
            input_tokens: Math.max(0, (u.input_tokens ?? 0) - cacheRead),
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
          },
        },
      },
    }];
  }

  // --- permissions ---------------------------------------------------------------------------

  private permission(requestId: string | number, params: any): GrokAction[] {
    const toolCall = params?.toolCall ?? {};
    const options: AcpPermissionOption[] = Array.isArray(params?.options) ? params.options : [];
    const pending: PendingPermission = {
      requestId: String(toolCall.toolCallId ?? requestId),
      toolName: String(toolCall.title ?? toolCall.kind ?? 'tool'),
      toolUseId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined,
      input: toolCall.rawInput ?? {},
    };
    return [{
      kind: 'approval',
      requestId,
      pending,
      options,
      alwaysSurface: false,
      autoApprove: buildPermissionResponse({ behavior: 'allow' }, options),
    }];
  }
}

/** The tool_result body: Grok's own prompt-facing rendering when present, else the content
 *  blocks' text. */
function toolOutput(update: any): string {
  const raw = update?.rawOutput?.output_for_prompt;
  if (typeof raw === 'string' && raw) return raw;
  const content = Array.isArray(update?.content) ? update.content : [];
  return content.map((c: any) => c?.content?.text ?? '').join('');
}

/**
 * Direction 2: map a Claude PermissionDecision onto one of the ACP request's own options.
 * allow → the first `allow_*` option (else the first option); deny → the first `reject_*`
 * option, or the ACP `cancelled` outcome when the request offers no way to say no.
 */
export function buildPermissionResponse(decision: PermissionDecision, options: AcpPermissionOption[]): unknown {
  const pick = (want: 'allow' | 'reject'): AcpPermissionOption | undefined =>
    options.find((o) => typeof o?.kind === 'string' && o.kind.startsWith(want));
  if (decision.behavior === 'allow') {
    const opt = pick('allow') ?? options[0];
    return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
  }
  const opt = pick('reject');
  return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
}
