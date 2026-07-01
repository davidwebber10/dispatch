import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConvItem, PendingPermission } from '../../../api/types';
import { openStructuredSocket } from '../../../api/structured-socket';
import { api, type ContentBlock } from '../../../api/client';

export interface StructuredChat {
  items: ConvItem[];
  busy: boolean;        // a turn is in flight (sent or streaming, no result yet)
  model?: string;
  // Accepts plain text OR a content-block array (e.g. a real image block the model SEES).
  send: (content: string | ContentBlock[]) => void;
  /** The AskUserQuestion / gated tool this thread is blocked on, or null. */
  pending: PendingPermission | null;
  /** Answer the pending AskUserQuestion. `answers` is keyed by question TEXT →
   *  the chosen option label(s) (multi-select joined with ", "). Verified wire shape
   *  against real `claude --permission-prompt-tool stdio`. */
  answer: (answers: Record<string, string>) => void;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
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
  // The AskUserQuestion the CLI is blocked on (mirrored in a ref so the `answer`
  // callback and the tool_result handler read the latest value without re-subscribing).
  const [pending, setPendingState] = useState<PendingPermission | null>(null);
  const permissionRef = useRef<PendingPermission | null>(null);
  const setPending = useCallback((p: PendingPermission | null) => { permissionRef.current = p; setPendingState(p); }, []);

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
    if (!terminalId) { setItems([]); setBusy(false); setModel(undefined); setPending(null); return; }
    setItems([]); setBusy(false); setModel(undefined); setPending(null);
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
        blockMapRef.current.clear();
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
          // Streaming mode: text/thinking already rendered from deltas — ignore them
          // to avoid duplication. Reconcile each tool_use's parsed input from the
          // authoritative whole event (and append any tool we never saw start, e.g.
          // if its content_block_start was trimmed out of the replay ring).
          if (streamingRef.current) {
            // Land any buffered deltas first so trailing text/thinking isn't lost and
            // no later frame overwrites the authoritative tool input reconciled below.
            flushNow();
            const tools = event.message.content.filter((b: any) => b.type === 'tool_use');
            if (tools.length) {
              setItems((p) => {
                const haveIds = new Set(p.filter((i) => i.kind === 'tool' && i.toolId).map((i) => i.toolId));
                const next = p.map((it) => {
                  if (it.kind !== 'tool' || !it.toolId) return it;
                  const m = tools.find((b: any) => b.id === it.toolId);
                  return m ? { ...it, toolInput: safeJson(m.input), toolFile: m.input?.file_path ?? m.input?.path ?? it.toolFile } : it;
                });
                for (const b of tools) {
                  if (!haveIds.has(b.id)) next.push({ kind: 'tool', toolName: b.name, toolId: b.id, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path });
                }
                return next;
              });
            }
            return;
          }
          // Fallback (no stream_events ever arrived): build from the whole event.
          const add: ConvItem[] = [];
          for (const b of event.message.content) {
            if (b.type === 'text' && b.text) add.push({ kind: 'assistant', text: b.text });
            else if (b.type === 'thinking') add.push({ kind: 'thinking', text: b.thinking ?? b.text ?? '' });
            else if (b.type === 'tool_use') add.push({ kind: 'tool', toolName: b.name, toolId: b.id, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path });
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
          const add: ConvItem[] = [];
          if (typeof content === 'string') {
            // A plain human turn rebuilt from the transcript backfill (resume after a daemon
            // restart) stores `content` as a STRING, not an array. Handle it so the user's own
            // messages aren't dropped on reconnect — assistant turns are always array-shaped,
            // which is why only the user's bubbles went missing after a restart.
            if (content.trim()) add.push({ kind: 'user', text: content, ...(source ? { source } : {}) });
          } else if (Array.isArray(content)) {
            for (const b of content) {
              if (b.type === 'tool_result') {
                // The pending AskUserQuestion just produced its result → it's answered
                // (by us or elsewhere); drop the interactive card.
                if (b.tool_use_id && permissionRef.current?.toolUseId === b.tool_use_id) setPending(null);
                add.push({ kind: 'tool-result', toolId: b.tool_use_id, text: flattenContent(b.content), isError: b.is_error === true });
                // flattenContent yields the text body only; surface any image blocks nested
                // inside the tool_result (e.g. a screenshot tool) as their own image items.
                add.push(...imagesFromContent(b.content, sessionIdRef.current));
              } else if (b.type === 'text' && b.text) {
                // P0a: the backend buffers/echoes the user's own turn as a text block.
                add.push({ kind: 'user', text: b.text, ...(source ? { source } : {}) });
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

  return { items, busy, model, send, pending, answer };
}
