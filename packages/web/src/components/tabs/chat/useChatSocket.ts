import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { modelFromFrame } from '../../../lib/modelName';
import { useActiveModel } from '../../../stores/activeModel';
import type { ConvItem, PendingPermission } from '../../../api/types';
import { openStructuredSocket } from '../../../api/structured-socket';
import { safeJson, flattenContent, imageItemFromBlock, imagesFromContent, userOrNotice, errorText } from './convItems';
import { threadViewCache } from '../../../lib/threadViewCache';
import { shownThisTurn, withSeq, type ChatHistory } from './useChatHistory';
import type { ApiRetry, AuthRequired, CompactResult } from './useStructuredChat';
import type { ChatBusy } from './useChatBusy';

// The live socket of a structured chat and the fold of its events into the timeline. Moved out of
// useStructuredChat.ts unchanged (W3-C, move-only split).

/** Best-effort file path from a (possibly complete) tool input JSON string. */
function fileFromInput(json: string): string | undefined {
  try {
    const o = JSON.parse(json);
    return o?.file_path ?? o?.path ?? undefined;
  } catch { return undefined; }
}

/** The text of a user turn for the echo match: runs of white space are one space, the ends are cut.
 *  The daemon and the CLI may trim or re-wrap a message; the words are what identifies it. */
function echoKey(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Append `add` to `prev`. A `user` item from the daemon whose text matches a local bubble (one this
 * client added at Send, see `send`) REPLACES that bubble: one message, one bubble. It keeps the
 * bubble's row key, so the DOM node stays. When other items already follow the local bubble (a replay
 * after a reconnect put the history under it), the bubble is removed and the echo is appended, so the
 * turn sits where the daemon has it. A coordinator-relayed turn is never the echo of an owner send.
 */
function appendWithEchoMatch(prev: ConvItem[], add: ConvItem[]): ConvItem[] {
  let next = prev;
  const rest: ConvItem[] = [];
  for (const it of add) {
    if (it.kind === 'user' && !it.localId && it.source !== 'coordinator' && next.some((x) => x.localId)) {
      const want = echoKey(it.text);
      const idx = next.findIndex((x) => !!x.localId && x.kind === 'user' && echoKey(x.text) === want);
      if (idx >= 0) {
        const local = next[idx];
        next = next.slice();
        const inPlace = rest.length === 0 && next.slice(idx + 1).every((x) => !!x.localId);
        if (inPlace) { next[idx] = { ...it, uuid: it.uuid ?? local.uuid }; continue; }
        next.splice(idx, 1);
      }
    }
    rest.push(it);
  }
  return rest.length ? [...next, ...rest] : next;
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

export function useChatSocket(args: {
  terminalId: string;
  sessionId?: string;
  setItems: Dispatch<SetStateAction<ConvItem[]>>;
  setStale: Dispatch<SetStateAction<boolean>>;
  /** "Is a turn in flight?" is the daemon's answer, not this fold's (W3-C): see useChatBusy. */
  busy: Pick<ChatBusy, 'frame' | 'socketReset' | 'socketClosed' | 'sendFailed'>;
  setModel: Dispatch<SetStateAction<string | undefined>>;
  setAuthRequired: Dispatch<SetStateAction<AuthRequired | null>>;
  setContextTokens: Dispatch<SetStateAction<number | undefined>>;
  setContextWindow: Dispatch<SetStateAction<number | undefined>>;
  setCompacting: Dispatch<SetStateAction<boolean>>;
  setCompactResult: Dispatch<SetStateAction<CompactResult | null>>;
  setApiRetry: Dispatch<SetStateAction<ApiRetry | null>>;
  setPending: (p: PendingPermission | null) => void;
  permissionRef: MutableRefObject<PendingPermission | null>;
  history: ChatHistory;
}): void {
  const {
    terminalId, sessionId, setItems, setStale, busy, setModel, setAuthRequired, setContextTokens, setContextWindow,
    setCompacting, setCompactResult, setApiRetry, setPending, permissionRef,
  } = args;
  const {
    pageableRef, hasMoreRef, setHasMore, loadingOlderRef, setLoadingOlder, oldestLineRef, pageTokenRef,
    itemsRef, anchorBlockedRef, inactiveHydratedRef, hydrateInactive,
  } = args.history;
  const clearApiRetry = () => setApiRetry((p) => (p ? null : p));

  // Session is read by the image parser (path refs → byte route) but must NOT key the
  // socket effect — it can resolve a render after terminalId, and we don't want that to
  // tear down + reopen the ws. A ref lets the in-effect closures read the latest value.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // W3-D: the journal hooks of the history module, read through a ref inside the socket effect.
  const journalRef = useRef(args.history);
  journalRef.current = args.history;

  // Streaming bookkeeping (refs so rapid deltas don't churn renders for tracking).
  const streamingRef = useRef(false);                 // sticky once any stream_event seen
  const turnRef = useRef(0);                           // monotonic turn id → unique block keys
  const blockMapRef = useRef<Map<number, BlockRec>>(new Map()); // content-block index → record
  // Keys of replies added from a stop's final_text (see content_block_stop below). They do not make
  // the stream "own" the view, so a REST page still loading after a reconnect still lands.
  const recoveredRef = useRef<Set<string>>(new Set());

  // rAF coalescing: deltas mutate the BlockRec buffers above + add the rec to a
  // dirty set; a single rAF then applies ALL dirty recs in ONE setItems map, so a
  // token burst renders ~once per frame instead of once per delta.
  const pendingRef = useRef<Set<BlockRec>>(new Set()); // recs with buffered deltas not yet rendered
  const rafRef = useRef<number | null>(null);          // scheduled flush handle (null ⇒ none pending)

  useEffect(() => {
    if (!terminalId) {
      setItems([]); setStale(false); setModel(undefined); setPending(null);
      setContextTokens(undefined); setContextWindow(undefined); setCompacting(false); setCompactResult(null); setApiRetry(null);
      hasMoreRef.current = pageableRef.current; setHasMore(pageableRef.current);
      loadingOlderRef.current = false; setLoadingOlder(false);
      oldestLineRef.current = undefined; pageTokenRef.current += 1;
      inactiveHydratedRef.current = false; anchorBlockedRef.current = false;
      return;
    }
    // W2-I: start from what this page last showed of the thread (the same array the first render used, so
    // this is no second render). `staleSet` holds the items that the daemon's replay will replace.
    const cached = threadViewCache.get(terminalId) ?? [];
    let staleSet = new Set<ConvItem>(cached);
    let staleActive = cached.length > 0;
    setItems(cached); setStale(staleActive);
    setModel(undefined); setPending(null); setAuthRequired(null);
    useActiveModel.getState().clear(terminalId); // the connect's system/model frame brings the current one
    setContextTokens(undefined); setContextWindow(undefined); setCompacting(false); setCompactResult(null); setApiRetry(null);
    hasMoreRef.current = pageableRef.current && !staleActive; setHasMore(hasMoreRef.current);
    loadingOlderRef.current = false; setLoadingOlder(false);
    oldestLineRef.current = undefined; pageTokenRef.current += 1; // discard any in-flight fetch from the previous thread
    inactiveHydratedRef.current = false; anchorBlockedRef.current = false;
    streamingRef.current = false; turnRef.current = 0; blockMapRef.current.clear(); recoveredRef.current.clear();
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

    // Append whole-event items. Plain append: the anchorless newest-window fetch that once
    // required uuid-dedup here is gone — loadOlder never fetches without an anchor, and the
    // inactive-rescue page only lands on a view with no conversation items to collide with
    // (see the 'system'/'inactive' handler below).
    const appendItems = (add: ConvItem[]) => {
      // W3-D: the items of a finished event carry its journal sequence; a sequence the view has is not added twice.
      const seq = journalRef.current.seqRef.current;
      if (add.length) setItems((p) => appendWithEchoMatch(p, withSeq(p, add, seq)));
    };

    // W2-I: the stale items (the view cache at open, or the items kept through a reconnect) go the moment
    // the replay brings the first real item, in the same render. A local bubble that still waits for its
    // echo stays: the replay holds its echo (which then replaces it), or the echo is still to come.
    // Paging is armed again here: a stale view offers no older page (see the reset above).
    const isStale = (it: ConvItem) => staleSet.has(it) && !it.localId;
    const dropStale = () => {
      if (!staleActive) return;
      staleActive = false; setStale(false);
      setItems((p) => (p.some(isStale) ? p.filter((it) => !isStale(it)) : p));
      hasMoreRef.current = pageableRef.current; setHasMore(pageableRef.current);
    };

    const sock = openStructuredSocket({
      terminalId,
      // W3-D: the message journal. The history module keeps the cursor, sees each event before the fold
      // (for its `seq`) and applies the journal frame; the stale handling and the append stay here.
      resumeAfter: () => journalRef.current.resumeCursor(),
      onEventSeen: (event) => journalRef.current.noteEvent(event),
      onJournal: (frame) => journalRef.current.onJournalFrame(frame, {
        dropStale, keepStale: () => { staleActive = false; setStale(false); }, merge: appendWithEchoMatch, sessionId: sessionIdRef.current,
      }),
      onReset: () => {
        // Reconnect: server replays its buffer. Clear the view + per-turn tracking so
        // replayed deltas rebuild cleanly. `streamingRef` stays sticky (per-thread).
        // Drop any queued flush so a stale frame can't write into the cleared view.
        if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        pendingRef.current.clear();
        // W2-I: the items stay on screen, marked stale, until the replay's first item replaces them
        // (dropStale). Emptying the view here left it blank for the 3 to 4 round trips of the replay.
        // The mark is taken inside an updater, so it sees every item already queued, and it runs
        // before dropStale's updater, which is queued later.
        staleActive = true; setStale(true);
        setItems((p) => { staleSet = new Set(p); return p; });
        busy.socketReset();
        setPending(null); // the server re-sends a still-pending permission after replay
        setAuthRequired(null); // the replay re-sends a standing system/auth_required
        setContextTokens(undefined); setContextWindow(undefined); setCompacting(false); setCompactResult(null); setApiRetry(null); // replay rebuilds these
        blockMapRef.current.clear(); recoveredRef.current.clear();
        // Re-arm pagination too: `items` above is being fully rebuilt from a fresh replay,
        // so a stale REST anchor from before the reconnect could otherwise skip a gap of
        // history between the new tail replay and where the old anchor left off.
        // No older page from the stale view; dropStale arms paging again.
        hasMoreRef.current = false; setHasMore(false);
        loadingOlderRef.current = false; setLoadingOlder(false);
        oldestLineRef.current = undefined; pageTokenRef.current += 1;
        inactiveHydratedRef.current = false; anchorBlockedRef.current = false;
      },
      onClose: () => {
        // P0b safety net: with no socket nothing is known about the turn, so stop spinning.
        // The status header of the next connection says what is true.
        busy.socketClosed();
      },
      onReplayEnd: () => {
        // A batched replay is folded. A local bubble with no echo in it (its POST is still on its way)
        // was kept above the replayed history: put it back at the end, where the owner typed it.
        setItems((p) => {
          const firstLocal = p.findIndex((it) => !!it.localId);
          if (firstLocal < 0 || p.slice(firstLocal).every((it) => !!it.localId)) return p;
          return [...p.filter((it) => !it.localId), ...p.filter((it) => !!it.localId)];
        });
      },
      onEvent: (event: any) => {
        // W3-C: the daemon's status frame says whether a turn is in flight. It is not part of the
        // timeline. Every other frame goes on to the fold, which no longer decides "busy".
        if (busy.frame(event)) return;
        const type = event?.type;
        // W2-I: the first frame that can render (not a `system` line, not a permission) is the replay
        // or a live turn: the stale items go now, in the same render as what replaces them. The
        // `system/inactive` sentinel is handled below: it keeps them until the REST page is here.
        if (staleActive && type !== 'system' && type !== 'permission') dropStale();

        // The active model: the newest frame that names one wins (lib/modelName's modelFromFrame).
        const reported = modelFromFrame(event);
        if (reported) { setModel(reported); useActiveModel.getState().set(terminalId, reported); }
        if (type === 'system' && event.subtype === 'init') return;
        if (type === 'system' && event.subtype === 'auth_required') {
          setAuthRequired({ provider: event.provider, ...(event.accountId ? { accountId: event.accountId } : {}), reason: event.reason, ...(event.detail ? { detail: event.detail } : {}) });
          return;
        }
        if (type === 'system' && event.subtype === 'model') {
          // A switch (the Pretty model switcher) leaves a line in the chat; the connect-time
          // model frame does not.
          if (event.switched === true && reported) appendItems([{ kind: 'system', systemKind: 'model', text: reported }]);
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
          hydrateInactive(() => {
            const wasStale = staleActive ? new Set(staleSet) : null;
            dropStale();
            return wasStale;
          }, recoveredRef);
          return;
        }

        // A model-call retry (529 overload, 5xx): surface it so the busy slot can say what's
        // actually happening — during an outage the CLI retries for minutes and a bare
        // "Working…" spinner reads as a dead session. Cleared on any turn progress below.
        // The thread's process could not start (its manager could not spawn it). Say why, and stop
        // the spinner: no turn is coming (#76).
        // A model/effort change the harness refused: the daemon says so in the thread, so it is not mistaken for one
        // that took hold (the card also shows the reason where it was asked).
        if (type === 'system' && event.subtype === 'settings_refused') {
          const why = typeof event.message === 'string' && event.message ? event.message : 'The model or effort change was refused.';
          setItems((p) => [...p, { kind: 'result', isError: true, text: why }]);
          return;
        }

        if (type === 'system' && event.subtype === 'spawn_error') {
          busy.sendFailed(); // no turn will come of the send
          const why = typeof event.message === 'string' && event.message ? event.message : 'unknown error';
          setItems((p) => [...p, { kind: 'result', isError: true, text: `Could not start the thread: ${why}` }]);
          return;
        }

        if (type === 'system' && event.subtype === 'api_retry') {
          setApiRetry({
            attempt: typeof event.attempt === 'number' ? event.attempt : 0,
            maxRetries: typeof event.max_retries === 'number' ? event.max_retries : 0,
            errorStatus: typeof event.error_status === 'number' ? event.error_status : undefined,
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
        // A null frame only says the pending went away (answered, cancelled, stale). It leaves
        // busy alone: after a reply the turn is running, and the spinner must not flicker off.
        if (type === 'permission') {
          if (event.pending) {
            setPending(event.pending as PendingPermission);
          } else {
            setPending(null);
          }
          return;
        }

        // --- Streaming protocol (Anthropic stream_event) ---------------------
        if (type === 'stream_event' && event.event) {
          streamingRef.current = true;
          clearApiRetry(); // the call went through — retries are over
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

          // A Codex message's stop carries its whole text (codex-translate.ts, 2026-10-12). Its
          // deltas reach only a view that saw the block start: after a socket reconnect, or a
          // return to the thread mid-reply, they were dropped above and the reply stayed missing
          // until a reload. The whole text wins over the streamed one; a missed block is added,
          // unless this turn already shows the same text (a REST page read after it was written).
          if (se.type === 'content_block_stop' && typeof se.final_text === 'string') {
            const finalText: string = se.final_text;
            const rec = blockMapRef.current.get(se.index);
            if (rec) {
              if (rec.kind === 'assistant' && rec.text !== finalText) {
                rec.text = finalText;
                pendingRef.current.add(rec); scheduleFlush();
              }
              return;
            }
            if (!finalText.trim()) return;
            const key = `s-${turnRef.current}-${se.index}`;
            blockMapRef.current.set(se.index, { key, kind: 'assistant', text: finalText, revealed: finalText.length });
            recoveredRef.current.add(key);
            setItems((p) => (shownThisTurn(p, finalText) ? p : [...p, { kind: 'assistant', text: finalText, uuid: key }]));
            return;
          }

          // content_block_stop / message_delta / message_stop: nothing structural.
          return;
        }

        if (type === 'assistant' && Array.isArray(event.message?.content)) {
          clearApiRetry(); // the call went through — retries are over
          // Context fill: the LATEST assistant call's usage (not a running sum — result.usage
          // sums every API round-trip in a multi-tool turn, badly over-counting). Recomputed
          // on every assistant event so it always reflects the most recent call.
          const usage = event.message?.usage;
          if (usage) {
            const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            setContextTokens(tokens);
          }
          if (typeof event.context_window === 'number' && event.context_window > 0) setContextWindow(event.context_window);
          // Claude Code's own per-message-block identity (verified against a real captured
          // session — see backfillEventsFromTranscript's doc comment): the SAME field the
          // on-disk transcript writes per line, so an item built from this live event and one
          // built from a REST/transcript-parsed page (conversation/transcript.ts) share one
          // stable identity. Threaded onto every item below so loadOlder's dedup/anchor can
          // use real identity instead of a lossy content fingerprint.
          const uuid = typeof event.uuid === 'string' ? event.uuid : undefined;
          // Streaming mode: text/thinking ALREADY rendered from deltas — ignore those to
          // avoid duplication. Reconcile each tool_use's parsed input from the authoritative
          // whole event, and append any block we never saw start (a tool, or — see
          // REPLAY-CUT RECOVERY below — text/thinking), e.g. because its content_block_start
          // was trimmed out of the replay ring.
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
            // REPLAY-CUT RECOVERY. The ws replay is bounded to the last 200 ring events, so it
            // can start PAST a message's content_block_start. Those orphaned deltas are dropped
            // (no BlockRec to land in — see content_block_delta above), and `streamingRef` is
            // sticky, so this reconcile's "text/thinking already rendered from deltas" rule
            // used to lose that message's prose from BOTH sources — permanently. Any block this
            // whole event reports whose stream index never opened a BlockRec was rendered by
            // nothing, so it is appended here from the authoritative whole event — the SAME
            // rule already applied to "any tool we never saw start", now covering text/thinking
            // too, and in content order so a recovered block keeps its place relative to the
            // rest of the message. `index` is a position in this message's content array, which
            // is exactly what a stream_event's `index` addresses. The check is presence-only
            // (not the rec's kind): if an index ever failed to line up, skipping is the safe
            // direction — a miss, never a duplicated bubble.
            const appendable: { b: any; index: number }[] = event.message.content
              .map((b: any, index: number) => ({ b, index }))
              .filter(({ b, index }: { b: any; index: number }) => b.type === 'tool_use'
                || ((b.type === 'text' || b.type === 'thinking') && !blockMapRef.current.has(index)));
            if (appendable.length || (uuid && blockKeys.size)) {
              setItems((p) => {
                // DEFENSE-IN-DEPTH (replay/REST overlap): if this message's real uuid is already
                // rendered by an item OUTSIDE this stream burst (a REST-hydrated copy), drop the
                // burst's rebuilt items instead of upgrading them — upgrading would leave two
                // items sharing one identity, i.e. the same turn rendered twice. With the
                // anchorless fetch gone this cannot occur today; it exists so a future overlap
                // regression duplicates nothing. (Burst items still carry synthetic `s-` keys
                // here, so `it.uuid === uuid` matches an outside copy — or an already-upgraded
                // item from an earlier reconcile of this SAME message, in which case the filter
                // removes nothing and this is a harmless no-op.)
                if (uuid && p.some((it) => it.uuid === uuid)) {
                  return p.filter((it) => !(it.uuid && blockKeys.has(it.uuid)));
                }
                const haveIds = new Set(p.filter((i) => i.kind === 'tool' && i.toolId).map((i) => i.toolId));
                const next = p.map((it) => {
                  const patch: Partial<ConvItem> = {};
                  // The uuid upgrade keeps the block's first key, so per-block UI state survives it.
                  if (uuid && it.uuid && blockKeys.has(it.uuid)) { patch.uuid = uuid; if (!it.blockKey) patch.blockKey = it.uuid; }
                  if (it.kind === 'tool' && it.toolId) {
                    const m = tools.find((b: any) => b.id === it.toolId);
                    if (m) { patch.toolInput = safeJson(m.input); patch.toolFile = m.input?.file_path ?? m.input?.path ?? it.toolFile; }
                  }
                  return Object.keys(patch).length ? { ...it, ...patch } : it;
                });
                for (const { b } of appendable) {
                  if (b.type === 'tool_use') {
                    if (!haveIds.has(b.id)) next.push({ kind: 'tool', toolName: b.name, toolId: b.id, toolInput: safeJson(b.input), toolFile: b.input?.file_path ?? b.input?.path, ...(uuid ? { uuid } : {}) });
                    continue;
                  }
                  // text / thinking whose content_block_start the replay cut (see appendable).
                  const text = b.type === 'thinking' ? (b.thinking ?? b.text ?? '') : (b.text ?? '');
                  if (!text) continue; // an empty block would render as a blank bubble
                  next.push({ kind: b.type === 'thinking' ? 'thinking' : 'assistant', text, ...(uuid ? { uuid } : {}) });
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
          appendItems(add);
          return;
        }

        if (type === 'user' && event.message) {
          // Injected context (loaded Skill content, system reminders) arrives as a user-role text
          // message the CLI synthesizes — NOT the human's turn. Skip it, mirroring the REST parser
          // (conversation/transcript.ts skips the on-disk `isMeta` equivalent). Live stream marks it
          // `isSynthetic`; also guard `isMeta` for any transcript-shaped event. The daemon's own
          // user-echo (manager.ts) sets neither, so real turns are unaffected.
          if (event.isSynthetic || event.isMeta) return;
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
            if (content.trim()) { const it = userOrNotice(content, source, uuid); if (it) add.push(it); }
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
                const it = userOrNotice(b.text, source, uuid);
                if (it) add.push(it);
              } else if (b.type === 'image') {
                // A human-attached image on the user's own turn — tag it so surfaces can
                // attribute it to "You" (vs. the tool_result images above, which stay
                // unattributed assistant/tool output).
                const img = imageItemFromBlock(b, sessionIdRef.current);
                if (img) add.push({ ...img, imageFromUser: true });
              }
            }
          }
          appendItems(add);
          return;
        }

        if (type === 'result') {
          flushNow(); // land any buffered trailing tokens before the footer
          // A turn that worked proves the login works again: the signed-out card goes.
          if (event.is_error !== true && event.subtype !== 'backfill') setAuthRequired(null);
          // A CLI blocked on a question cannot end a turn, so any card still up is stale. On
          // replay the server re-sends a live pending after the ring, so this never hides one.
          setPending(null);
          clearApiRetry(); // turn over — either recovered or gave up with an error result
          // Synthetic result from backfillEventsFromTranscript (see cc-sessions.ts): Claude
          // Code transcripts never write a real trailing `result` line, so a revived
          // completed thread's replay would otherwise end on `assistant` with nothing to
          // clear `busy`. It carries no telemetry, so swallow it before it becomes a
          // rendered <ResultFooter/> card.
          if (event.subtype === 'backfill') return;
          appendItems([{
            kind: 'result',
            isError: event.is_error === true,
            costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
            turns: typeof event.num_turns === 'number' ? event.num_turns : undefined,
            durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
            tokensIn: event.usage?.input_tokens,
            tokensOut: event.usage?.output_tokens,
            text: event.is_error ? errorText(event) : undefined,
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
      // W2-I: keep what the view showed for the next open of this thread. Not while it is still
      // stale: then the cache already holds the same items, and an empty view must not replace them.
      if (!staleActive) threadViewCache.put(terminalId, itemsRef.current);
    };
  }, [terminalId, setPending, hydrateInactive, busy.frame, busy.socketReset, busy.socketClosed, busy.sendFailed]);
}
