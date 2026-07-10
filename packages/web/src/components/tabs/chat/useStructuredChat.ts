import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConvItem, PendingPermission } from '../../../api/types';
import { openStructuredSocket } from '../../../api/structured-socket';
import { api, type ContentBlock } from '../../../api/client';

/** Fallback context window (tokens) for when no model is known yet. Every model Dispatch
 *  actually runs (sonnet-5, opus-4.x) has a native 1M-token window; only Haiku is 200k. */
export const CONTEXT_WINDOW = 1_000_000;

/** JSONL lines fetched per older-history page via loadOlder(), mirroring ConversationView's
 *  own reverse-infinite-scroll window size (packages/web/src/components/tabs/ConversationView.tsx). */
const OLDER_PAGE_LIMIT = 120;

/** The real context window (tokens) for a given model id. Sonnet-5 and Opus-4.x — the
 *  only models Dispatch's tiering assigns to coordinator/implementer/planner/researcher/
 *  reviewer roles — natively support 1M tokens with no beta flag needed. Haiku is the
 *  one exception, capped at 200k. */
export function contextWindowFor(model?: string): number {
  return model?.includes('haiku') ? 200_000 : 1_000_000;
}

/** The outcome of the most recent native compaction, or null before any has run. */
export interface CompactResult {
  success: boolean;
  error?: string;
}

export interface StructuredChat {
  items: ConvItem[];
  busy: boolean;        // a turn is in flight (sent or streaming, no result yet)
  model?: string;
  /** Context tokens used AS OF the latest assistant turn (input + cache_read + cache_creation).
   *  Undefined until the first assistant event of the thread lands. Compare against
   *  contextWindowFor(model) to render a fill indicator. */
  contextTokens?: number;
  /** True while a native `/compact` triggered via `compact()` is in progress. */
  compacting: boolean;
  /** Outcome of the most recently finished compaction (transient — for a toast/indicator). */
  compactResult: CompactResult | null;
  // Accepts plain text OR a content-block array (e.g. a real image block the model SEES).
  send: (content: string | ContentBlock[]) => void;
  /** The AskUserQuestion / gated tool this thread is blocked on, or null. */
  pending: PendingPermission | null;
  /** Answer the pending AskUserQuestion. `answers` is keyed by question TEXT →
   *  the chosen option label(s) (multi-select joined with ", "). Verified wire shape
   *  against real `claude --permission-prompt-tool stdio`. */
  answer: (answers: Record<string, string>) => void;
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
   * ws fold above — it never emits `image` items, never carries `toolId` (tool_use/
   * tool_result pairing falls back to array adjacency), and never carries `source` (a
   * coordinator-relayed turn reads as a plain "You" bubble instead of "via Dispatch" once
   * paged in). Accepted for v1: the live tail, where users spend most of their time, stays
   * full-fidelity via the ws; only older, scrolled-past-the-fold history degrades.
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

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/**
 * Content-fingerprint FALLBACK for dedup'ing a loadOlder() page against what's already in
 * `items`, for items on either side that lack the real `uuid` identity (see loadOlder's own
 * dedup, which checks uuid FIRST and only consults this for the remainder — e.g. the
 * client's own optimistic echo of a just-sent turn, which predates any uuid the CLI/transcript
 * assigns it). `ts` is excluded since a ws-built item doesn't always set it. This is a
 * heuristic, not an identity: two genuinely distinct turns with identical rendered content
 * (rare) would collide — accepted as the fallback of last resort, not the primary check.
 */
function convItemFingerprint(it: ConvItem): string {
  return [it.kind, it.toolId ?? '', it.toolName ?? '', it.text ?? '', it.toolInput ?? ''].join(' ');
}

/** tool_result.content is frequently an array of blocks ([{type:'text',text}]) —
 * common for MCP tools and some built-ins — rather than a plain string. Flatten it
 * to text so the Output tab and rich tool views render readable content instead of
 * a raw JSON blob. Falls back to pretty JSON for any other (object) shape. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('');
  }
  return safeJson(content);
}

/** Best-effort file path from a (possibly complete) tool input JSON string. */
function fileFromInput(json: string): string | undefined {
  try {
    const o = JSON.parse(json);
    return o?.file_path ?? o?.path ?? undefined;
  } catch { return undefined; }
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
function imageItemFromBlock(b: any, sessionId?: string): ConvItem | null {
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
function imagesFromContent(content: unknown, sessionId?: string): ConvItem[] {
  if (!Array.isArray(content)) return [];
  const out: ConvItem[] = [];
  for (const b of content) {
    const img = imageItemFromBlock(b, sessionId);
    if (img) out.push(img);
  }
  return out;
}

/** Tracks one in-progress streamed content block within the current turn.
 * `text` accumulates text/thinking deltas; `jsonAccum` accumulates tool input
 * JSON. Deltas are buffered here and applied to the items in a single rAF flush
 * (see below) so a burst of tokens costs ~one render per frame, not per token.
 * `revealed` is how much of `text` has been shown so far for assistant/thinking
 * blocks — see REVEAL_CATCHUP below; unused for tool blocks. */
interface BlockRec { key: string; kind: 'assistant' | 'thinking' | 'tool'; jsonAccum?: string; text?: string; revealed?: number }

/** Reveal pacing for streamed prose (assistant/thinking text). Confirmed via
 * instrumented reproduction that neither the ws client nor the daemon buffer
 * stream_event deltas (structured-socket.ts forwards onmessage synchronously;
 * the daemon's readline/emit/ws.send chain has no timers or queues) — the CLI
 * itself delivers text in bursts of roughly a sentence every several hundred ms
 * rather than a steady per-token trickle. Snapping straight to each burst reads
 * as choppy pop-in even though the render itself is cheap (no dropped frames).
 * Each frame closes CATCHUP of the remaining gap (min 1 char), so a typical
 * ~100-char burst reveals over ~150-250ms — smoothed, but never far behind the
 * data that already arrived. Tool-call JSON isn't prose and stays un-animated. */
const REVEAL_CATCHUP = 0.3;
function nextRevealed(revealed: number, targetLen: number): number {
  const gap = targetLen - revealed;
  return gap <= 0 ? targetLen : revealed + Math.max(1, Math.ceil(gap * REVEAL_CATCHUP));
}

/**
 * Drives a structured (stream-json) thread for the chat UI. Opens the live ws,
 * folds raw events into a flat ConvItem timeline, pairs tool calls with their
 * results by id (robust to parallel/interleaved tools), captures the per-turn
 * `result` (cost/tokens/duration) and the model, and tracks a `busy` flag.
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
export function useStructuredChat(terminalId: string, sessionId?: string): StructuredChat {
  const [items, setItems] = useState<ConvItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string | undefined>();
  const [contextTokens, setContextTokens] = useState<number | undefined>();
  const [compacting, setCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<CompactResult | null>(null);
  // The AskUserQuestion the CLI is blocked on (mirrored in a ref so the `answer`
  // callback and the tool_result handler read the latest value without re-subscribing).
  const [pending, setPendingState] = useState<PendingPermission | null>(null);
  const permissionRef = useRef<PendingPermission | null>(null);
  const setPending = useCallback((p: PendingPermission | null) => { permissionRef.current = p; setPendingState(p); }, []);

  // Older-history pagination (loadOlder). Refs mirror the state so the stable loadOlder
  // callback below always reads the CURRENT hasMore/loadingOlder without needing them in
  // its dependency array (which would otherwise change its identity on every fetch).
  const [hasMore, setHasMore] = useState(true); // optimistic until the first loadOlder() settles
  const [loadingOlder, setLoadingOlder] = useState(false);
  const hasMoreRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const oldestLineRef = useRef<number | undefined>(undefined); // REST `before` anchor; undefined = not yet probed
  const pageTokenRef = useRef(0); // bumped on terminal switch to discard a stale in-flight fetch
  // Mirrors `items` so loadOlder's stable callback can read the CURRENT oldest item's
  // uuid (for the first call's precise `beforeUuid` anchor) without depending on `items`
  // in its own closure — same rationale as the hasMore/loadingOlder refs above.
  const itemsRef = useRef<ConvItem[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  // Bug 1 (archived agent shows an empty chat): latches once we've hydrated from the REST
  // transcript after a `system/inactive` signal (no live process ⇒ nothing to ws-replay),
  // so a later reconnect / duplicate signal doesn't re-fetch. Reset alongside the other
  // per-thread refs below.
  const inactiveHydratedRef = useRef(false);

  // Session is read by the image parser (path refs → byte route) but must NOT key the
  // socket effect — it can resolve a render after terminalId, and we don't want that to
  // tear down + reopen the ws. A ref lets the in-effect closures read the latest value.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Streaming bookkeeping (refs so rapid deltas don't churn renders for tracking).
  const streamingRef = useRef(false);                 // sticky once any stream_event seen
  const turnRef = useRef(0);                           // monotonic turn id → unique block keys
  const blockMapRef = useRef<Map<number, BlockRec>>(new Map()); // content-block index → record

  // rAF coalescing: deltas mutate the BlockRec buffers above + add the rec to a
  // dirty set; a single rAF then applies ALL dirty recs in ONE setItems map, so a
  // token burst renders ~once per frame instead of once per delta.
  const pendingRef = useRef<Set<BlockRec>>(new Set()); // recs with buffered deltas not yet rendered
  const rafRef = useRef<number | null>(null);          // scheduled flush handle (null ⇒ none pending)

  useEffect(() => {
    if (!terminalId) {
      setItems([]); setBusy(false); setModel(undefined); setPending(null);
      setContextTokens(undefined); setCompacting(false); setCompactResult(null);
      hasMoreRef.current = true; setHasMore(true);
      loadingOlderRef.current = false; setLoadingOlder(false);
      oldestLineRef.current = undefined; pageTokenRef.current += 1;
      inactiveHydratedRef.current = false;
      return;
    }
    setItems([]); setBusy(false); setModel(undefined); setPending(null);
    setContextTokens(undefined); setCompacting(false); setCompactResult(null);
    hasMoreRef.current = true; setHasMore(true);
    loadingOlderRef.current = false; setLoadingOlder(false);
    oldestLineRef.current = undefined; pageTokenRef.current += 1; // discard any in-flight fetch from the previous thread
    inactiveHydratedRef.current = false;
    streamingRef.current = false; turnRef.current = 0; blockMapRef.current.clear();
    pendingRef.current.clear();
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }

    // Apply every buffered delta to its item in a single setItems map, then clear
    // the dirty set + the rAF handle. Keyed by item uuid (the block's stable key),
    // so it works even after blockMapRef was cleared by a new message_start.
    // `instant`: skip the reveal animation and jump straight to the full target
    // text — used at natural turn-settling checkpoints (see flushNow) so no
    // latency is added to when the final text becomes fully visible.
    const flush = (instant: boolean) => {
      rafRef.current = null;
      const pending = pendingRef.current;
      if (pending.size === 0) return;
      const byKey = new Map<string, BlockRec>();
      for (const rec of pending) byKey.set(rec.key, rec);
      pending.clear();
      // Compute each rec's next `revealed` length in plain sync code BEFORE calling
      // setItems — React doesn't guarantee the setItems updater runs synchronously
      // before the next line, so anything the "is still animating?" decision depends
      // on has to be settled here, not as a side effect inside the updater closure.
      let animating = false;
      for (const rec of byKey.values()) {
        if (rec.kind === 'tool') continue; // tool JSON isn't revealed gradually
        const target = rec.text ?? '';
        rec.revealed = instant ? target.length : nextRevealed(rec.revealed ?? 0, target.length);
        if (rec.revealed < target.length) {
          animating = true;
          pending.add(rec); // not caught up — stays dirty so next frame continues the reveal
        }
      }
      setItems((p) => p.map((it) => {
        const rec = it.uuid ? byKey.get(it.uuid) : undefined;
        if (!rec) return it;
        if (rec.kind === 'tool') {
          const accum = rec.jsonAccum ?? '';
          const file = fileFromInput(accum); // resolves once accum is complete JSON
          return { ...it, toolInput: accum, ...(file ? { toolFile: file } : {}) };
        }
        // assistant / thinking: reveal the accumulated text gradually (see REVEAL_CATCHUP)
        // instead of snapping to it, so a bursty delta doesn't pop in all at once.
        return { ...it, text: (rec.text ?? '').slice(0, rec.revealed ?? 0) };
      }));
      if (animating) scheduleFlush();
    };
    const scheduleFlush = () => {
      if (rafRef.current != null) return; // a flush is already queued for this frame
      rafRef.current = requestAnimationFrame(() => flush(false));
    };
    // Force a synchronous, fully-revealed flush now (cancelling any queued one). Used
    // before the whole-`assistant` reconcile and `result` so no trailing tokens are
    // lost, a stale frame can't later clobber the authoritative reconciled tool input,
    // and the turn's final text isn't left mid-reveal when the footer lands.
    const flushNow = () => {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      flush(true);
    };

    const sock = openStructuredSocket({
      terminalId,
      onReset: () => {
        // Reconnect: server replays its buffer. Clear the view + per-turn tracking so
        // replayed deltas rebuild cleanly. `streamingRef` stays sticky (per-thread).
        // Drop any queued flush so a stale frame can't write into the cleared view.
        if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        pendingRef.current.clear();
        setItems([]); setBusy(false);
        setPending(null); // the server re-sends a still-pending permission after replay
        setContextTokens(undefined); setCompacting(false); setCompactResult(null); // replay rebuilds these
        blockMapRef.current.clear();
        // Re-arm pagination too: `items` above is being fully rebuilt from a fresh replay,
        // so a stale REST anchor from before the reconnect could otherwise skip a gap of
        // history between the new tail replay and where the old anchor left off.
        hasMoreRef.current = true; setHasMore(true);
        loadingOlderRef.current = false; setLoadingOlder(false);
        oldestLineRef.current = undefined; pageTokenRef.current += 1;
        inactiveHydratedRef.current = false;
      },
      onClose: () => {
        // P0b safety net: if the ws drops we can't trust an in-flight turn to ever
        // emit `result`, so stop spinning. A live reconnect re-sets busy via deltas.
        setBusy(false);
      },
      onEvent: (event: any) => {
        const type = event?.type;

        if (type === 'system' && event.subtype === 'init') {
          const m = event.model || event.session?.model || event.modelId;
          if (m) setModel(m);
          return;
        }

        // BUG 1 fix: no live process backs this thread (e.g. an archived agent — see
        // service.ts's ensureStructuredAlive, which deliberately never revives one), so the
        // ws replay above sent nothing and `items` would otherwise stay stuck on EmptyState
        // forever even though the conversation fully exists on disk. Hydrate the initial
        // view from the REST transcript instead, exactly like a manual loadOlder() page.
        // Latched (not re-fired on a reconnect) and only applied if nothing has populated
        // `items` in the meantime (defensive — a live 'event' landing first wins).
        if (type === 'system' && event.subtype === 'inactive') {
          if (inactiveHydratedRef.current) return;
          inactiveHydratedRef.current = true;
          const tok = pageTokenRef.current;
          loadingOlderRef.current = true; setLoadingOlder(true);
          api.getConversation(terminalId, { limit: OLDER_PAGE_LIMIT })
            .then((conv) => {
              if (tok !== pageTokenRef.current) return; // thread switched / ws reset mid-flight
              oldestLineRef.current = conv.startLine;
              hasMoreRef.current = conv.hasMore; setHasMore(conv.hasMore);
              if (conv.items.length) setItems((prev) => (prev.length ? prev : conv.items));
            })
            .catch(() => { /* transient — the next near-top scroll retries via loadOlder */ })
            .finally(() => {
              if (tok === pageTokenRef.current) { loadingOlderRef.current = false; setLoadingOlder(false); }
            });
          return;
        }

        // Native compaction lifecycle: `status:"compacting"` while it runs, then a
        // follow-up status (status:null) carrying compact_result — a fresh system/init
        // for the post-compaction context follows separately and lands in the branch above.
        if (type === 'system' && event.subtype === 'status') {
          if (event.status === 'compacting') {
            setCompacting(true);
            setCompactResult(null);
          } else {
            setCompacting(false);
            if (event.compact_result === 'success' || event.compact_result === 'failed') {
              setCompactResult({ success: event.compact_result === 'success', error: event.compact_error });
            }
          }
          return;
        }

        // Escalation frame (ws/structured.ts) — an AskUserQuestion / gated tool the CLI
        // is blocked on. Surface it for the interactive card and stop the "Working…"
        // spinner: we're now waiting on the HUMAN, not the model. Answering resumes busy.
        if (type === 'permission') {
          setPending((event.pending as PendingPermission) ?? null);
          setBusy(false);
          return;
        }

        // --- Streaming protocol (Anthropic stream_event) ---------------------
        if (type === 'stream_event' && event.event) {
          streamingRef.current = true;
          setBusy(true);
          const se = event.event;

          if (se.type === 'message_start') {
            turnRef.current += 1;
            blockMapRef.current.clear();
            return;
          }

          if (se.type === 'content_block_start') {
            const idx = se.index;
            const cb = se.content_block || {};
            const key = `s-${turnRef.current}-${idx}`;
            if (cb.type === 'text') {
              blockMapRef.current.set(idx, { key, kind: 'assistant', text: '' });
              setItems((p) => [...p, { kind: 'assistant', text: '', uuid: key }]);
            } else if (cb.type === 'thinking') {
              blockMapRef.current.set(idx, { key, kind: 'thinking', text: '' });
              setItems((p) => [...p, { kind: 'thinking', text: '', uuid: key }]);
            } else if (cb.type === 'tool_use') {
              blockMapRef.current.set(idx, { key, kind: 'tool', jsonAccum: '' });
              setItems((p) => [...p, { kind: 'tool', toolName: cb.name, toolId: cb.id, toolInput: '', uuid: key }]);
            } else if (cb.type === 'image') {
              // Images arrive whole at content_block_start (no deltas), so there's no
              // BlockRec to track — append directly. The whole-`assistant` reconcile below
              // only touches tool_use blocks, so this won't duplicate.
              const img = imageItemFromBlock(cb, sessionIdRef.current);
              if (img) setItems((p) => [...p, { ...img, uuid: key }]);
            }
            return;
          }

          if (se.type === 'content_block_delta') {
            const rec = blockMapRef.current.get(se.index);
            if (!rec) return;
            const d = se.delta || {};
            // Buffer into the rec + mark dirty; the rAF flush renders it. No per-delta setItems.
            if (d.type === 'text_delta' && rec.kind === 'assistant') {
              rec.text = (rec.text ?? '') + (d.text ?? '');
              pendingRef.current.add(rec); scheduleFlush();
            } else if (d.type === 'thinking_delta' && rec.kind === 'thinking') {
              rec.text = (rec.text ?? '') + (d.thinking ?? '');
              pendingRef.current.add(rec); scheduleFlush();
            } else if (d.type === 'input_json_delta' && rec.kind === 'tool') {
              rec.jsonAccum = (rec.jsonAccum ?? '') + (d.partial_json ?? '');
              pendingRef.current.add(rec); scheduleFlush();
            }
            return;
          }

          // content_block_stop / message_delta / message_stop: nothing structural.
          return;
        }

        if (type === 'assistant' && Array.isArray(event.message?.content)) {
          setBusy(true);
          // Context fill: the LATEST assistant call's usage (not a running sum — result.usage
          // sums every API round-trip in a multi-tool turn, badly over-counting). Recomputed
          // on every assistant event so it always reflects the most recent call.
          const usage = event.message?.usage;
          if (usage) {
            const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            setContextTokens(tokens);
          }
          // Claude Code's own per-message-block identity (verified against a real captured
          // session — see backfillEventsFromTranscript's doc comment): the SAME field the
          // on-disk transcript writes per line, so an item built from this live event and one
          // built from a REST/transcript-parsed page (conversation/transcript.ts) share one
          // stable identity. Threaded onto every item below so loadOlder's dedup/anchor can
          // use real identity instead of a lossy content fingerprint.
          const uuid = typeof event.uuid === 'string' ? event.uuid : undefined;
          // Streaming mode: text/thinking already rendered from deltas — ignore them
          // to avoid duplication. Reconcile each tool_use's parsed input from the
          // authoritative whole event (and append any tool we never saw start, e.g.
          // if its content_block_start was trimmed out of the replay ring).
          if (streamingRef.current) {
            // Land any buffered deltas first so trailing text/thinking isn't lost and
            // no later frame overwrites the authoritative tool input reconciled below.
            flushNow();
            // Every block this whole event reports belongs to the message that was just
            // streamed (blockMapRef is cleared per message_start — see above), so these are
            // exactly the synthetic per-block keys (`s-turn-idx`) created at content_block_start
            // for THIS message. Upgrading them to the real `uuid` here is what lets a later
            // loadOlder() page recognize (and correctly dedup) this same item from disk.
            const blockKeys = new Set(Array.from(blockMapRef.current.values(), (r) => r.key));
            const tools = event.message.content.filter((b: any) => b.type === 'tool_use');
            if (tools.length || (uuid && blockKeys.size)) {
              setItems((p) => {
                const haveIds = new Set(p.filter((i) => i.kind === 'tool' && i.toolId).map((i) => i.toolId));
                const next = p.map((it) => {
                  const patch: Partial<ConvItem> = {};
                  if (uuid && it.uuid && blockKeys.has(it.uuid)) patch.uuid = uuid;
                  if (it.kind === 'tool' && it.toolId) {
                    const m = tools.find((b: any) => b.id === it.toolId);
                    if (m) { patch.toolInput = safeJson(m.input); patch.toolFile = m.input?.file_path ?? m.input?.path ?? it.toolFile; }
                  }
                  return Object.keys(patch).length ? { ...it, ...patch } : it;
                });
                for (const b of tools) {
                  if (!haveIds.has(b.id)) next.push({ kind: 'tool', toolName: b.name, toolId: b.id, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path, ...(uuid ? { uuid } : {}) });
                }
                return next;
              });
            }
            return;
          }
          // Fallback (no stream_events ever arrived): build from the whole event.
          const add: ConvItem[] = [];
          for (const b of event.message.content) {
            if (b.type === 'text' && b.text) add.push({ kind: 'assistant', text: b.text, ...(uuid ? { uuid } : {}) });
            else if (b.type === 'thinking') add.push({ kind: 'thinking', text: b.thinking ?? b.text ?? '', ...(uuid ? { uuid } : {}) });
            else if (b.type === 'tool_use') add.push({ kind: 'tool', toolName: b.name, toolId: b.id, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path, ...(uuid ? { uuid } : {}) });
            else if (b.type === 'image') { const img = imageItemFromBlock(b, sessionIdRef.current); if (img) add.push(img); }
          }
          if (add.length) setItems((p) => [...p, ...add]);
          return;
        }

        if (type === 'user' && event.message) {
          const content = event.message.content;
          // Who actually sent this turn — tagged by the backend on the echoed event (absent
          // on untagged/legacy sends, which render as a plain "You" bubble). See ConvItem.source.
          const source = event.meta?.source as ConvItem['source'] | undefined;
          // See the 'assistant' handler above — the same Claude Code per-message-block
          // identity, present on a live 'user' event too (verified against a real captured
          // session). Absent on the client's own optimistic echo (manager.ts's sendMessage
          // synthesizes that event before the CLI's real one exists) — fine, since that item
          // is never going to collide with an older REST page anyway.
          const uuid = typeof event.uuid === 'string' ? event.uuid : undefined;
          const add: ConvItem[] = [];
          if (typeof content === 'string') {
            // A plain human turn rebuilt from the transcript backfill (resume after a daemon
            // restart) stores `content` as a STRING, not an array. Handle it so the user's own
            // messages aren't dropped on reconnect — assistant turns are always array-shaped,
            // which is why only the user's bubbles went missing after a restart.
            if (content.trim()) add.push({ kind: 'user', text: content, ...(source ? { source } : {}), ...(uuid ? { uuid } : {}) });
          } else if (Array.isArray(content)) {
            for (const b of content) {
              if (b.type === 'tool_result') {
                // The pending AskUserQuestion just produced its result → it's answered
                // (by us or elsewhere); drop the interactive card.
                if (b.tool_use_id && permissionRef.current?.toolUseId === b.tool_use_id) setPending(null);
                add.push({ kind: 'tool-result', toolId: b.tool_use_id, text: flattenContent(b.content), isError: b.is_error === true, ...(uuid ? { uuid } : {}) });
                // flattenContent yields the text body only; surface any image blocks nested
                // inside the tool_result (e.g. a screenshot tool) as their own image items.
                add.push(...imagesFromContent(b.content, sessionIdRef.current));
              } else if (b.type === 'text' && b.text) {
                // P0a: the backend buffers/echoes the user's own turn as a text block.
                add.push({ kind: 'user', text: b.text, ...(source ? { source } : {}), ...(uuid ? { uuid } : {}) });
              } else if (b.type === 'image') {
                // A human-attached image on the user's own turn — tag it so surfaces can
                // attribute it to "You" (vs. the tool_result images above, which stay
                // unattributed assistant/tool output).
                const img = imageItemFromBlock(b, sessionIdRef.current);
                if (img) add.push({ ...img, imageFromUser: true });
              }
            }
          }
          if (add.length) setItems((p) => [...p, ...add]);
          return;
        }

        if (type === 'result') {
          flushNow(); // land any buffered trailing tokens before the footer
          setBusy(false);
          // Synthetic result from backfillEventsFromTranscript (see cc-sessions.ts): Claude
          // Code transcripts never write a real trailing `result` line, so a revived
          // completed thread's replay would otherwise end on `assistant` with nothing to
          // clear `busy`. It carries no telemetry, so swallow it before it becomes a
          // rendered <ResultFooter/> card.
          if (event.subtype === 'backfill') return;
          setItems((p) => [...p, {
            kind: 'result',
            isError: event.is_error === true,
            costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
            turns: typeof event.num_turns === 'number' ? event.num_turns : undefined,
            durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
            tokensIn: event.usage?.input_tokens,
            tokensOut: event.usage?.output_tokens,
            text: typeof event.result === 'string' && event.is_error ? event.result : undefined,
          }]);
          return;
        }
      },
    });
    return () => {
      // Cancel a queued flush so a torn-down/replayed thread can't flush stale state.
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      pendingRef.current.clear();
      sock.close();
    };
  }, [terminalId, setPending]);

  const send = useCallback((content: string | ContentBlock[]) => {
    // A string turn is trimmed + empty-guarded as before; a block turn (e.g. an image)
    // just needs at least one block. Both flow through the SAME widened API.
    const payload = typeof content === 'string' ? content.trim() : content;
    const empty = typeof payload === 'string' ? !payload : payload.length === 0;
    if (empty || !terminalId) return;
    // No optimistic user bubble: the backend echoes the turn as a `user` event (text or
    // image blocks, surviving reconnect replay), so an optimistic append would double up.
    setBusy(true);
    api.sendStructuredMessage(terminalId, payload).catch(() => {
      // P0c: the POST rejects (e.g. the claude process died → 400) — surface it and
      // stop spinning instead of leaving "Working…" forever.
      setBusy(false);
      setItems((p) => [...p, { kind: 'result', isError: true, text: 'Failed to send message' }]);
    });
  }, [terminalId]);

  // Answer the pending AskUserQuestion. `answers` is keyed by question TEXT → the chosen
  // option label(s). We fire the REST call (the ws has no inbound channel), clear the card
  // optimistically, and resume the spinner — the CLI unblocks and streams the next turn.
  const answer = useCallback((answers: Record<string, string>) => {
    const p = permissionRef.current;
    if (!p || !terminalId) return;
    setPending(null);
    setBusy(true);
    api.answerPermission(terminalId, { requestId: p.requestId, decision: 'allow', answers }).catch(() => {
      // The POST failed (e.g. the process died) — re-surface the question so it isn't lost.
      setBusy(false);
      setPending(p);
    });
  }, [terminalId, setPending]);

  // Trigger native compaction. No optimistic state change: the CLI's own system/status
  // events (handled above) are the source of truth for `compacting`/`compactResult`.
  const compact = useCallback(() => {
    if (!terminalId) return;
    api.compactTerminal(terminalId).catch(() => {});
  }, [terminalId]);

  // Page in the next older window of REST-backed history and prepend it to `items` (see
  // the loadOlder doc comment on StructuredChat above for the shape-parity gap this
  // accepts). Reads/writes via refs (not the hasMore/loadingOlder state directly) so this
  // callback stays stable per terminalId instead of churning on every fetch.
  const loadOlder = useCallback(() => {
    if (!terminalId || loadingOlderRef.current || !hasMoreRef.current) return;
    const tok = pageTokenRef.current;
    // First call only (no numeric anchor probed yet): anchor precisely on the oldest
    // already-rendered item's real identity, so this fetches genuinely-older content
    // instead of the newest REST window (which would just overlap the ws-replayed tail —
    // see getConversation's doc comment on `beforeUuid`). A "real" identity is a Claude Code
    // transcript uuid — NOT the synthetic `s-<turn>-<idx>` key a still-streaming block carries
    // before the whole-assistant reconcile upgrades it (see content_block_start), which the
    // server can't resolve on disk.
    const firstCall = oldestLineRef.current === undefined;
    const beforeUuid = firstCall
      ? itemsRef.current.find((it) => it.uuid && !it.uuid.startsWith('s-'))?.uuid
      : undefined;
    // ANCHORLESS-FETCH GUARD: on the first call, if the ws replay hasn't settled a real-uuid
    // item yet (items empty, or only synthetic streaming keys), do NOT fetch. An anchorless
    // request makes getConversation return the NEWEST window — the whole transcript — which the
    // ws onEvent handlers then re-append with no dedup, rendering the conversation twice. Bail
    // and let BootstrapOlderPages / a near-top scroll retry once the replay settles an anchor.
    // loadOlder serves strictly-older history; the newest window is owned by the ws replay.
    if (firstCall && !beforeUuid) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    api.getConversation(terminalId, { before: oldestLineRef.current, ...(beforeUuid ? { beforeUuid } : {}), limit: OLDER_PAGE_LIMIT })
      .then((conv) => {
        if (tok !== pageTokenRef.current) return; // thread switched / ws reset mid-flight — discard
        oldestLineRef.current = conv.startLine;
        hasMoreRef.current = conv.hasMore;
        setHasMore(conv.hasMore);
        if (conv.items.length) {
          // Dedup against what's already rendered by real identity (shared Claude Code
          // message uuid — see the 'assistant'/'user' handlers above and transcript.ts)
          // when both sides have one; that catches the case a content fingerprint alone
          // misses (a tool call whose ws-rendered toolId/pretty-JSON toolInput differ from
          // the REST/transcript-parsed version's bare-string input, e.g. Bash — same tool
          // call, different formatting). Fingerprint stays as a fallback for items on
          // either side that predate this identity (the client's own optimistic echo, an
          // image, which the REST parser never emits anyway).
          setItems((prev) => {
            const seenUuids = new Set(prev.map((it) => it.uuid).filter((u): u is string => !!u));
            const seenFingerprints = new Set(prev.map(convItemFingerprint));
            const fresh = conv.items.filter((it) => {
              if (it.uuid && seenUuids.has(it.uuid)) return false;
              return !seenFingerprints.has(convItemFingerprint(it));
            });
            return fresh.length ? [...fresh, ...prev] : prev;
          });
        }
      })
      .catch(() => { /* transient — the next near-top scroll retries */ })
      .finally(() => {
        if (tok === pageTokenRef.current) { loadingOlderRef.current = false; setLoadingOlder(false); }
      });
  }, [terminalId]);

  return { items, busy, model, contextTokens, compacting, compactResult, send, pending, answer, compact, hasMore, loadingOlder, loadOlder };
}
