import { textToSend } from '../../../lib/slashEscape';
import { useCallback, useRef, useState } from 'react';
import type { ConvItem, PendingPermission } from '../../../api/types';
import { api, type ContentBlock } from '../../../api/client';
import { sendFailureText } from '../../../lib/sendError';
import { threadViewCache } from '../../../lib/threadViewCache';
import { useChatBusy } from './useChatBusy';
import { useChatHistory } from './useChatHistory';
import { useChatQuestions } from './useChatQuestions';
import { useChatSocket } from './useChatSocket';

/** Fallback context window (tokens) for when no model is known yet. Every model Dispatch
 *  actually runs (sonnet-5, opus-4.x) has a native 1M-token window; only Haiku is 200k. */
export const CONTEXT_WINDOW = 1_000_000;

/** The real context window (tokens) for a given model id. Sonnet-5 and Opus-4.x — the
 *  only models Dispatch's tiering assigns to coordinator/implementer/planner/researcher/
 *  reviewer roles — natively support 1M tokens with no beta flag needed. Haiku is the
 *  one exception, capped at 200k. */
export function contextWindowFor(model?: string): number {
  return model?.includes('haiku') ? 200_000 : 1_000_000;
}

/** A model-call retry in flight (from the CLI's `system/api_retry` events). */
export interface ApiRetry {
  attempt: number;
  maxRetries: number;
  errorStatus?: number;
}

/** The outcome of the most recent native compaction, or null before any has run. */
export interface CompactResult {
  success: boolean;
  error?: string;
}

/** A signed-out login, as core's auth/auth-failure.ts reports it. */
export interface AuthRequired {
  provider: 'claude' | 'codex' | 'grok' | 'opencode';
  accountId?: string;
  reason: string;
  detail?: string;
}

export interface StructuredChat {
  items: ConvItem[];
  /** True while `items` is what this page last saw of the thread (the view cache, or the items
   *  kept through a reconnect) and the daemon's replay has not replaced it yet (W2-I). */
  stale: boolean;
  /** A turn is in flight. From the daemon's status snapshot (`turnOpen`), or a send that is on its way (W3-C). */
  busy: boolean;
  model?: string;
  /** Context tokens used AS OF the latest assistant turn (input + cache_read + cache_creation).
   *  Undefined until the first assistant event of the thread lands. Compare against
   *  contextWindowFor(model) to render a fill indicator. */
  contextTokens?: number;
  /** The wire-reported context-window size (tokens), when the harness sends one — beats
   *  the contextWindowFor(model) table. Today only ACP/OpenCode reports it. */
  contextWindow?: number;
  /** True while a native `/compact` triggered via `compact()` is in progress. */
  compacting: boolean;
  /** Outcome of the most recently finished compaction (transient — for a toast/indicator). */
  compactResult: CompactResult | null;
  /** Live API-retry state (the CLI's system/api_retry events): the model call is failing
   *  and being retried — e.g. a 529 outage — which can run for MINUTES behind an otherwise
   *  bare "Working…" spinner. Null when no retry is in flight; cleared the moment the turn
   *  progresses (stream/assistant) or ends (result). */
  apiRetry: ApiRetry | null;
  /** The thread's login is signed out or expired (the daemon's system/auth_required event), or
   *  null. Kept through later failures; cleared when a turn succeeds. */
  authRequired: AuthRequired | null;
  // Accepts plain text OR a content-block array (e.g. a real image block the model SEES).
  send: (content: string | ContentBlock[]) => void;
  /** Send again the message of a bubble whose POST failed (`sendState: 'failed'`), by its `localId`. */
  retrySend: (localId: string) => void;
  /** The AskUserQuestion / gated tool this thread is blocked on, or null. */
  pending: PendingPermission | null;
  /** Answer the pending AskUserQuestion. `answers` is keyed by question TEXT →
   *  the chosen option label(s) (multi-select joined with ", "). Verified wire shape
   *  against real `claude --permission-prompt-tool stdio`. */
  /** Returns false when the answer was dropped because a reply or Dismiss is in flight. */
  answer: (answers: Record<string, string>) => void | boolean;
  /** A chat reply to the pending question: the text rides a deny, images follow as their own
   *  turn. Falls back to a normal send on 404/409. Rejects on any other failure, card kept. */
  /** Resolves false when the reply went out as a normal turn and the question is still open (409, e.g. Codex). */
  replyToQuestion: (content: string | ContentBlock[]) => Promise<boolean>;
  /** The card's empty Discuss or Dismiss: deny with the daemon's fixed text. Rejects on failure. */
  denyQuestion: (action: 'discuss' | 'dismiss') => Promise<void>;
  /** replyToQuestion / denyQuestion for the card's own buttons, with failures shown in the timeline. */
  /** Resolve true when the reply went out, false when it failed (the failure is already in the timeline). */
  replyFromCard: (text: string) => Promise<boolean>;
  denyFromCard: (action: 'discuss' | 'dismiss') => Promise<boolean>;
  /** Trigger native Claude Code compaction on this thread (no chat bubble is added). */
  compact: () => void;
  /** Whether an older page of history is believed to exist above the current window.
   *  Optimistic (true) until the first loadOlder() call settles. */
  hasMore: boolean;
  /** True while an older-page fetch (loadOlder) is in flight. */
  loadingOlder: boolean;
  /**
   * Page in the next older window of transcript history and prepend it to `items`. A
   * structured thread opens via a bounded ws replay (last 200 ring events, see
   * structured-socket.ts — that bound is what fixed the ~10s open delay on long threads),
   * so this reaches further back through the REST transcript endpoint instead
   * (`GET .../conversation?before=&limit=`, the same one ConversationView's own
   * reverse-infinite-scroll uses). No-ops while already loading or once hasMore is false.
   *
   * KNOWN SHAPE-PARITY GAP: the REST parser (conversation/transcript.ts) is leaner than the
   * ws fold above — it never emits `image` items and never carries `source` (a
   * coordinator-relayed turn reads as a plain "You" bubble instead of "via Dispatch" once
   * paged in). Accepted for v1: the live tail, where users spend most of their time, stays
   * full-fidelity via the ws; only older, scrolled-past-the-fold history degrades. It DOES
   * carry `toolId` now (both sides): Grok/ACP transcripts interleave thinking between a
   * tool_use and its tool_result, so the adjacency fallback paired nothing there and every
   * reloaded call rendered permanently "running…" — id pairing is position-independent.
   *
   * FIRST-CALL ANCHOR: `before` starts undefined, but the first call also passes
   * `beforeUuid` — the oldest already-rendered item's real Claude Code message identity
   * (the same `uuid` a ws-replayed item now carries — see the 'assistant'/'user' handlers
   * below and getConversation's doc comment on `beforeUuid`) — so the server can resolve a
   * precise line anchor instead of defaulting to the newest REST window. When no rendered
   * item has a uuid yet (e.g. only the client's own optimistic echo is on screen) or the
   * anchor isn't found on disk yet, this still falls back to the newest window; the dedup
   * below (real identity, with a content fingerprint as a fallback) makes that overlap
   * harmless either way, so anchor imprecision is a wasted fetch, never a correctness bug.
   */
  loadOlder: () => void;
}

/**
 * Drives a structured (stream-json) thread for the chat UI. Opens the live ws,
 * folds raw events into a flat ConvItem timeline, pairs tool calls with their
 * results by id (robust to parallel/interleaved tools), captures the per-turn
 * `result` (cost/tokens/duration) and the model. `busy` is not folded from the events: it is
 * the daemon's status snapshot (useChatBusy).
 *
 * AUTO-ADAPT streaming: once any `stream_event` is seen for the thread we set a
 * streaming flag and build the assistant side (text, thinking, tool_use args)
 * FROM the deltas, IGNORING the whole `assistant` event's blocks (to avoid
 * duplication) — though we still reconcile each tool_use's parsed input from the
 * whole event. If no stream_events ever arrive (older daemon), we fall back to
 * today's whole-`assistant` handling. tool_result still comes from `user` events,
 * the footer from `result`. The user's own turns arrive as echoed `user` text
 * blocks (the backend buffers them), so reconnect replay restores them.
 */
export function useStructuredChat(
  terminalId: string,
  sessionId?: string,
  opts?: {
    /**
     * False for a harness whose getConversation is `unsupported` (Grok): there is never
     * REST history to page, so the whole older-pages machinery stays off — no optimistic
     * hasMore (which rendered a permanently-inert "Load earlier messages" button, since
     * grok items carry no transcript uuid to anchor on), no bootstrap fetches. The full
     * ws-ring replay IS the recoverable history for such threads. Defaults to true.
     */
    pageableHistory?: boolean;
  },
): StructuredChat {
  const pageable = opts?.pageableHistory !== false;
  // W2-I: the FIRST render of a thread this page showed before has its last items (lib/threadViewCache),
  // so a tab switch back paints content in the same frame. They are stale until the replay replaces them.
  const [items, setItems] = useState<ConvItem[]>(() => (terminalId ? threadViewCache.get(terminalId) ?? [] : []));
  const [stale, setStale] = useState(() => items.length > 0);
  // W3-C: "busy" is the daemon's status snapshot, or a send on its way. No frame of the fold sets it.
  const busyControl = useChatBusy(terminalId);
  const { busy, beginSending, sendAccepted, sendFailed } = busyControl;
  const [model, setModel] = useState<string | undefined>();
  const [authRequired, setAuthRequired] = useState<AuthRequired | null>(null);
  const [contextTokens, setContextTokens] = useState<number | undefined>();
  // The REAL context-window size when the wire reports one (ACP usage_update.size, carried
  // as `context_window` on the assistant frame). Undefined → the per-model table
  // (contextWindowFor) stays the denominator, as before.
  const [contextWindow, setContextWindow] = useState<number | undefined>();
  const [compacting, setCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<CompactResult | null>(null);
  // API-retry visibility: set by system/api_retry, cleared by any sign the turn progressed
  // (stream_event / assistant / result) — functional clears bail out when already null so
  // per-delta stream events don't churn renders.
  const [apiRetry, setApiRetry] = useState<ApiRetry | null>(null);

  // Surface a failed send in the timeline and stop the spinner (P0c).
  const showSendFailure = useCallback((err: unknown) => {
    sendFailed();
    setItems((p) => [...p, { kind: 'result', isError: true, text: sendFailureText(err) }]);
  }, [sendFailed]);

  // The pending question and its actions (useChatQuestions), the older-history paging
  // (useChatHistory) and the socket fold (useChatSocket). The order is the order the hooks had
  // before the split: the history's items effect runs before the socket effect.
  const { pending, setPending, permissionRef, replyToQuestion, denyQuestion, replyFromCard, denyFromCard, answer } =
    useChatQuestions(terminalId, busyControl, showSendFailure);
  const history = useChatHistory(terminalId, pageable, items, setItems, stale);
  const { hasMore, loadingOlder, loadOlder } = history;
  useChatSocket({
    terminalId, sessionId, setItems, setStale, busy: busyControl, setModel, setAuthRequired, setContextTokens, setContextWindow,
    setCompacting, setCompactResult, setApiRetry, setPending, permissionRef, history,
  });

  // W2-I: the content of each local bubble, for Retry. Keyed by `localId`.
  const localSendsRef = useRef<Map<string, string | ContentBlock[]>>(new Map());
  const localSeqRef = useRef(0);

  const send = useCallback((content: string | ContentBlock[]) => {
    // A string turn is trimmed + empty-guarded as before; a block turn (e.g. an image)
    // just needs at least one block. Both flow through the SAME widened API.
    const payload = typeof content === 'string' ? textToSend(content) : content;
    const empty = typeof payload === 'string' ? !payload : payload.length === 0;
    if (empty || !terminalId) return;
    // A pending question takes the reply. A plain gated tool does not: that stays a normal send.
    if (permissionRef.current?.questions?.length) {
      replyToQuestion(payload).catch(showSendFailure);
      return;
    }
    // W2-I: the owner's bubble shows NOW, not one round trip later. The daemon still echoes the turn
    // as a `user` event (live and in every replay); that echo replaces this item (appendWithEchoMatch),
    // so there is one bubble. One item for each text block, as the echo has. No local bubble for an
    // image (the echo brings it) or for a slash command (the daemon runs it and may send no echo).
    const texts = (typeof payload === 'string' ? [payload] : payload.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])))
      .filter((t) => t.trim() && !t.startsWith('/'));
    let localId: string | undefined;
    if (texts.length) {
      const id = `local-${++localSeqRef.current}`;
      localId = id;
      localSendsRef.current.set(id, payload);
      // The `s-` prefix marks the key as not a transcript uuid (hasRealUuid), like a streamed block's.
      setItems((p) => [...p, ...texts.map((text, k): ConvItem => ({ kind: 'user', text, localId: id, sendState: 'sending', uuid: `s-${id}-${k}` }))]);
    }
    const settle = (state: 'failed' | undefined) => {
      if (!localId) return;
      if (!state) localSendsRef.current.delete(localId);
      setItems((p) => (p.some((it) => it.localId === localId)
        ? p.map((it) => { if (it.localId !== localId) return it; const { sendState: _s, ...rest } = it; return state ? { ...rest, sendState: state } : rest; })
        : p));
    };
    beginSending();
    // P0c: the POST rejects (e.g. the claude process died → 400) — surface it and
    // stop spinning instead of leaving "Working…" forever. The bubble is marked failed and offers Retry.
    api.sendStructuredMessage(terminalId, payload).then(() => { settle(undefined); sendAccepted(); }, (err) => { settle('failed'); showSendFailure(err); });
  }, [terminalId, replyToQuestion, showSendFailure, beginSending, sendAccepted]);

  const retrySend = useCallback((localId: string) => {
    const payload = localSendsRef.current.get(localId);
    if (payload === undefined) return;
    localSendsRef.current.delete(localId);
    setItems((p) => p.filter((it) => it.localId !== localId));
    send(payload);
  }, [send]);

  // Trigger native compaction. No optimistic state change: the CLI's own system/status
  // events (handled above) are the source of truth for `compacting`/`compactResult`.
  const compact = useCallback(() => {
    if (!terminalId) return;
    api.compactTerminal(terminalId).catch(() => {});
  }, [terminalId]);

  return {
    items, stale, busy, model, authRequired, contextTokens, contextWindow, compacting, compactResult, apiRetry, send, retrySend, pending, answer,
    replyToQuestion, denyQuestion, replyFromCard, denyFromCard, compact, hasMore, loadingOlder, loadOlder,
  };
}
