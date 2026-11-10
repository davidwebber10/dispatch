import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ConvItem, JournalFrame } from '../../../api/types';
import { api } from '../../../api/client';
import { itemsFromEvent } from './convItems';

// Older-history paging of a structured chat: the REST pages above the socket replay. Moved out of
// useStructuredChat.ts unchanged (W3-C, move-only split).

/** JSONL lines fetched per older-history page via loadOlder(), mirroring ConversationView's
 *  own reverse-infinite-scroll window size (packages/web/src/components/tabs/ConversationView.tsx). */
const OLDER_PAGE_LIMIT = 120;

/**
 * Content-fingerprint FALLBACK for dedup'ing a loadOlder() page against what's already in
 * `items`, for items on either side that lack the real `uuid` identity (see loadOlder's own
 * dedup, which checks uuid FIRST and only consults this for the remainder — e.g. the
 * client's own optimistic echo of a just-sent turn, which predates any uuid the CLI/transcript
 * assigns it). `ts` is excluded since a ws-built item doesn't always set it. This is a
 * heuristic, not an identity: two genuinely distinct turns with identical rendered content
 * (rare) would collide — accepted as the fallback of last resort, not the primary check.
 */
/**
 * True when this item carries a REAL Claude Code transcript uuid — a durable per-message
 * identity — as opposed to no uuid at all (the client's own optimistic echo) or the synthetic
 * `s-<turn>-<idx>` key a still-streaming block carries until the whole-assistant reconcile
 * upgrades it. Only a real uuid is trustworthy enough to decide "same message" on its own.
 */
function hasRealUuid(it: ConvItem): boolean {
  return !!it.uuid && !it.uuid.startsWith('s-');
}

function convItemFingerprint(it: ConvItem): string {
  // imageUrl is included so distinct images (which otherwise share an empty text/tool
  // fingerprint) don't collapse to one — matters now that REST pages can carry user-attached
  // images (recovered from mid-turn queued_command posts, see conversation/transcript.ts).
  return [it.kind, it.toolId ?? '', it.toolName ?? '', it.text ?? '', it.toolInput ?? '', it.imageUrl ?? ''].join(' ');
}

/** True when a REST-page assistant item after the last user turn already shows `text`: the same
 *  message, read from the transcript after Codex wrote it. Only page items count (they carry their
 *  transcript `line`); a live reply with the same words is a different message and both show. */
export function shownThisTurn(items: ConvItem[], text: string): boolean {
  const want = text.trim();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user') return false;
    if (it.kind === 'assistant' && it.line !== undefined && (it.text ?? '').trim() === want) return true;
  }
  return false;
}

/**
 * Says when a reconnect may ask the daemon for "only what is newer" (W3-D, the resume cursor).
 *
 * The daemon's message journal gives each FINISHED item a sequence, and the event that finished
 * the item carries it (`seq`). The view equals "the journal up to sequence N" only when nothing on
 * screen is still unfinished: a block that streams is on screen and is not a journal item yet. So
 * the tracker counts the streamed blocks that started and are not finished, and gives a cursor only
 * while the count is zero. With no cursor the reconnect gets the newest window again, as a first
 * open does: slower, never wrong.
 *
 * A streamed block is finished by: its stop when the stop carries a `seq` (Codex, ACP); a whole
 * `assistant` frame with a `seq` that belongs to the message that streams, one block for each
 * content block (Claude, matched on the message id); a `result` with a `seq` (a turn end finishes
 * every block; the daemon writes what was cut off before the footer).
 */
export class ResumeTracker {
  private unfinished = 0;
  private clean: number | undefined;
  /** The id of the message that streams, for the lead agent ('') and each sub-agent (its parent tool id). */
  private messageIds = new Map<string, string>();

  /** Fold one socket event. Returns the event's journal sequence, or undefined. */
  note(event: unknown): number | undefined {
    const e = event as any;
    if (!e || typeof e !== 'object') return undefined;
    const seq = typeof e.seq === 'number' ? e.seq : undefined;
    const parent = typeof e.parent_tool_use_id === 'string' ? e.parent_tool_use_id : '';
    if (e.type === 'stream_event' && e.event) {
      const se = e.event;
      if (se.type === 'message_start') {
        const id = se.message?.id;
        if (typeof id === 'string' && id) this.messageIds.set(parent, id); else this.messageIds.delete(parent);
      } else if (se.type === 'content_block_start') {
        this.unfinished += 1;
        this.clean = undefined;
      } else if (se.type === 'content_block_stop' && seq !== undefined) {
        this.unfinished = Math.max(0, this.unfinished - 1);
      }
    } else if (e.type === 'assistant' && seq !== undefined) {
      const id = this.messageIds.get(parent);
      const blocks = Array.isArray(e.message?.content) ? e.message.content.length : 0;
      if (id && e.message?.id === id) this.unfinished = Math.max(0, this.unfinished - blocks);
    } else if (e.type === 'result' && seq !== undefined) {
      this.unfinished = 0;
    }
    if (seq !== undefined) this.clean = this.unfinished === 0 ? seq : undefined;
    return seq;
  }

  /** The newest sequence the view holds completely, or undefined when a reconnect must get the window again. */
  cursor(): number | undefined { return this.clean; }

  /** A journal frame was applied: the view is the journal up to `seq`. The events after the frame open blocks again. */
  synced(seq: number): void {
    this.unfinished = 0;
    this.messageIds.clear();
    this.clean = seq;
  }

  reset(): void {
    this.unfinished = 0;
    this.messageIds.clear();
    this.clean = undefined;
  }
}

/**
 * `add` with the journal sequence of the event it came from. When the view has an item with that
 * sequence already, the event is the same item again and nothing is added: two items with the same
 * `seq` render once. With no sequence (an older daemon, a stream delta) `add` is returned as it is.
 */
export function withSeq(prev: ConvItem[], add: ConvItem[], seq: number | undefined): ConvItem[] {
  if (seq === undefined || !add.length) return add;
  if (prev.some((it) => it.seq === seq)) return [];
  return add.map((it) => (it.seq === seq ? it : { ...it, seq }));
}

/** What the socket module gives the journal frame handler: its own stale handling and its append. */
export interface JournalFrameContext {
  /** Remove the stale items (the view cache, or the items kept through a reconnect): the frame replaces them. */
  dropStale: () => void;
  /** The stale items are the truth after all: the frame only adds to them. */
  keepStale: () => void;
  /** The socket fold's append (a daemon echo replaces the local bubble of the same message). */
  merge: (prev: ConvItem[], add: ConvItem[]) => ConvItem[];
  sessionId?: string;
}

export type ChatHistory = ReturnType<typeof useChatHistory>;

export function useChatHistory(
  terminalId: string,
  pageable: boolean,
  items: ConvItem[],
  setItems: Dispatch<SetStateAction<ConvItem[]>>,
  /** True when the first render shows a stale view (the view cache). */
  stale: boolean,
) {
  // Read by the reset paths inside effects/callbacks keyed only on terminalId.
  const pageableRef = useRef(pageable);
  pageableRef.current = pageable;
  // Older-history pagination (loadOlder). Refs mirror the state so the stable loadOlder
  // callback below always reads the CURRENT hasMore/loadingOlder without needing them in
  // its dependency array (which would otherwise change its identity on every fetch).
  // Not from a stale view: its paging anchor would be thrown away with it when the replay lands.
  const [hasMore, setHasMore] = useState(() => pageable && !stale); // optimistic until the first loadOlder() settles
  const [loadingOlder, setLoadingOlder] = useState(false);
  const hasMoreRef = useRef(pageable && !stale);
  const loadingOlderRef = useRef(false);
  const oldestLineRef = useRef<number | undefined>(undefined); // REST `before` anchor; undefined = not yet probed
  const pageTokenRef = useRef(0); // bumped on terminal switch to discard a stale in-flight fetch
  // Mirrors `items` so loadOlder's stable callback can read the CURRENT oldest item's
  // uuid (for the first call's precise `beforeUuid` anchor) without depending on `items`
  // in its own closure — same rationale as the hasMore/loadingOlder refs above.
  const itemsRef = useRef<ConvItem[]>([]);
  // ANCHORLESS-BAIL RE-ARM. loadOlder's first call refuses to fetch while no rendered item
  // carries a real uuid (see its ANCHORLESS-FETCH GUARD — an anchorless fetch returns the
  // NEWEST window and double-renders the thread). That bail is correct, but it touched NO
  // state, and the only things that re-fire paging are useBootstrapOlderPages' effect
  // (deps: overflowing/hasMore/loadingOlder/loadOlder), a near-top scroll, and the
  // Load-earlier button — none of which change when an anchor finally arrives. So the FIRST
  // bail was permanent: the button stayed visible and inert forever, and the bootstrap loop
  // never ran again. That is routine on a streaming thread, because the bounded ws replay
  // (last 200 ring events, every stdout line included) can leave every rendered item on a
  // synthetic `s-<turn>-<idx>` key.
  // The fix: remember that a call bailed for want of an anchor, and bump `anchorRetry` the
  // moment a real uuid actually lands. `anchorRetry` is a loadOlder dependency, so its
  // identity changes — exactly the dependency the bootstrap effect re-runs on — and a scroll
  // or a button click after that point proceeds normally too. The nonce is bumped ONLY when
  // a real anchor exists (never on the bail itself), so it cannot spin.
  const anchorBlockedRef = useRef(false);
  const [anchorRetry, setAnchorRetry] = useState(0);
  useEffect(() => {
    itemsRef.current = items;
    if (anchorBlockedRef.current && items.some(hasRealUuid)) {
      anchorBlockedRef.current = false;
      setAnchorRetry((n) => n + 1);
    }
  }, [items]);
  // Bug 1 (archived agent shows an empty chat): latches once we've hydrated from the REST
  // transcript after a `system/inactive` signal (no live process ⇒ nothing to ws-replay),
  // so a later reconnect / duplicate signal doesn't re-fetch. Reset alongside the other
  // per-thread refs below.
  const inactiveHydratedRef = useRef(false);

  // W3-D: the daemon's message journal.
  // `journalRef`: set by a journal frame that replaced the view. While `more` is true, older pages come
  // from the journal route, before `oldestSeq`; after that from the transcript route, as before W3-D.
  const journalRef = useRef({ active: false, oldestSeq: 0, more: false });
  // The journal sequence of the event that the socket fold handles now (see noteEvent), or undefined.
  const seqRef = useRef<number | undefined>(undefined);
  const trackerRef = useRef(new ResumeTracker());
  const sessionRef = useRef<string | undefined>(undefined);
  // The paging state as this module last set it. A socket reconnect clears the live refs (the view is
  // about to be replaced); a resume keeps the view, so it puts this state back.
  const savedRef = useRef<{ hasMore?: boolean; oldestLine?: number }>({});
  useEffect(() => {
    journalRef.current = { active: false, oldestSeq: 0, more: false };
    seqRef.current = undefined;
    trackerRef.current.reset();
    savedRef.current = {};
  }, [terminalId]);

  /** The socket calls this with each event right before the fold. */
  const noteEvent = useCallback((event: unknown) => { seqRef.current = trackerRef.current.note(event); }, []);
  /** The cursor of a reconnect (`?after=`), or undefined: see ResumeTracker. */
  const resumeCursor = useCallback(() => trackerRef.current.cursor(), []);

  /**
   * The `journal` frame of the socket. `reset: true`: the newest window of the thread; it replaces
   * the view (the stale items go in the same render). `reset: false`: the answer to the cursor of a
   * reconnect; the view stays, with its paging state, and the frame's items are added. Either way an
   * item whose `seq` the view has already is not added a second time.
   */
  const onJournalFrame = useCallback((frame: JournalFrame, ctx: JournalFrameContext) => {
    sessionRef.current = ctx.sessionId;
    seqRef.current = undefined;
    const rows = Array.isArray(frame.items) ? frame.items : [];
    if (frame.reset) {
      ctx.dropStale();
      journalRef.current = { active: true, oldestSeq: rows[0]?.seq ?? frame.firstSeq, more: frame.hasMore === true };
      // Below the journal's first item, a harness with a transcript reads the transcript route.
      const more = journalRef.current.more || pageableRef.current;
      hasMoreRef.current = more; setHasMore(more);
      oldestLineRef.current = undefined;
      savedRef.current = { hasMore: more, oldestLine: undefined };
    } else {
      ctx.keepStale();
      const more = savedRef.current.hasMore ?? pageableRef.current;
      hasMoreRef.current = more; setHasMore(more);
      oldestLineRef.current = savedRef.current.oldestLine;
    }
    const lastSeq = Math.max(typeof frame.lastSeq === 'number' ? frame.lastSeq : 0, frame.after ?? 0, rows.length ? rows[rows.length - 1].seq : 0);
    trackerRef.current.synced(lastSeq);
    if (!rows.length) return;
    setItems((prev) => {
      const have = new Set<number>();
      for (const it of prev) if (it.seq !== undefined) have.add(it.seq);
      const add = rows.filter((r) => !have.has(r.seq)).flatMap((r) => itemsFromEvent(r.payload, ctx.sessionId, r.seq));
      return add.length ? ctx.merge(prev, add) : prev;
    });
  }, [setItems]);

  // The `system/inactive` rescue of the socket fold (see useChatSocket): hydrate the first view from
  // the REST transcript. `takeStale` returns the stale items that the page replaces, and drops them.
  const hydrateInactive = useCallback((takeStale: () => Set<ConvItem> | null, recoveredRef: MutableRefObject<Set<string>>) => {
    if (inactiveHydratedRef.current) return;
    inactiveHydratedRef.current = true;
    const tok = pageTokenRef.current;
    loadingOlderRef.current = true; setLoadingOlder(true);
    api.getConversation(terminalId, { limit: OLDER_PAGE_LIMIT })
      .then((conv) => {
        if (tok !== pageTokenRef.current) return; // thread switched / ws reset mid-flight
        // W2-I: the page is here, so the stale items it replaces go (they were kept on screen
        // while it loaded). `isStale` keeps them out of the "who owns the view" test below.
        const wasStale = takeStale();
        // Apply only while nothing CONVERSATIONAL is rendered. A ring that earned this
        // rescue replays no conversation items, but can still deposit a stale `result`
        // FOOTER (the result handler appends one for any non-backfill result) — a footer
        // alone doesn't own the view: hydrate and keep it BELOW the history, where the
        // newest turn's footer belongs. A real conversation item (a live turn that
        // started mid-flight) means the stream owns the view — discard the page AND
        // leave the paging anchor unset: anchoring at this page's startLine while
        // dropping its content would leave a gap later loadOlder() pages right past.
        // The anchor writes live INSIDE the updater: itemsRef syncs via a passive effect
        // and can lag a just-committed live event, so an outside check could anchor (or
        // latch hasMore=false, permanently killing loadOlder) on a page the updater is
        // about to discard. The updater's `prev` is the authoritative fresh state; the
        // itemsRef check outside is a fast-path only. The ref/setHasMore writes in here
        // are idempotent, so a double-invoked (StrictMode) updater is harmless.
        // A reply recovered from a stop's final_text is no such item: it stays under the
        // page, and is dropped only when the page already holds it (it completed before the
        // page was read) — else a recovery after a reconnect would cost the whole history.
        const recovered = (it: ConvItem) => !!it.uuid && recoveredRef.current.has(it.uuid);
        const conversational = (it: ConvItem) => it.kind !== 'result' && !recovered(it) && !(wasStale?.has(it) && !it.localId);
        if (itemsRef.current.some(conversational)) return; // fast path only
        setItems((prev) => {
          if (prev.some(conversational)) return prev; // authoritative — skips the anchor too
          oldestLineRef.current = conv.startLine;
          hasMoreRef.current = conv.hasMore; setHasMore(conv.hasMore);
          savedRef.current = { hasMore: conv.hasMore, oldestLine: conv.startLine };
          if (!conv.items.length) return prev;
          return [...conv.items, ...prev.filter((it) => !(recovered(it) && shownThisTurn(conv.items, it.text ?? '')))];
        });
      })
      .catch(() => { /* transient — the next near-top scroll retries via loadOlder */ })
      .finally(() => {
        if (tok === pageTokenRef.current) { loadingOlderRef.current = false; setLoadingOlder(false); }
      });
  }, [terminalId, setItems]);

  // Page in the next older window of REST-backed history and prepend it to `items` (see
  // the loadOlder doc comment on StructuredChat above for the shape-parity gap this
  // accepts). Reads/writes via refs (not the hasMore/loadingOlder state directly) so this
  // callback stays stable per terminalId instead of churning on every fetch.
  const loadOlder = useCallback(() => {
    if (!terminalId || loadingOlderRef.current || !hasMoreRef.current) return;
    const tok = pageTokenRef.current;
    // W3-D: while the journal has older items, the page comes from the journal route, before the oldest
    // sequence the view holds. An item is identified by its `seq`: no fingerprint, so nothing is removed
    // because its words equal another item's. When the journal is at its first item, the code below
    // takes over: the transcript route, for a harness that has one.
    if (journalRef.current.active && journalRef.current.more) {
      loadingOlderRef.current = true;
      setLoadingOlder(true);
      api.getJournal(terminalId, { before: journalRef.current.oldestSeq, limit: OLDER_PAGE_LIMIT })
        .then((page) => {
          if (tok !== pageTokenRef.current) return; // thread switched / ws reset mid-flight — discard
          const rows = Array.isArray(page.items) ? page.items : [];
          const journal = journalRef.current;
          if (rows.length) journal.oldestSeq = rows[0].seq;
          journal.more = page.hasMore === true && rows.length > 0;
          const more = journal.more || pageableRef.current;
          hasMoreRef.current = more; setHasMore(more);
          savedRef.current = { ...savedRef.current, hasMore: more };
          if (!rows.length) return;
          setItems((prev) => {
            const have = new Set<number>();
            for (const it of prev) if (it.seq !== undefined) have.add(it.seq);
            const fresh = rows.filter((r) => !have.has(r.seq)).flatMap((r) => itemsFromEvent(r.payload, sessionRef.current, r.seq));
            return fresh.length ? [...fresh, ...prev] : prev;
          });
        })
        .catch(() => { /* transient — the next near-top scroll retries */ })
        .finally(() => {
          if (tok === pageTokenRef.current) { loadingOlderRef.current = false; setLoadingOlder(false); }
        });
      return;
    }
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
    // ANCHORLESS-FETCH GUARD: on the first call, if no rendered item carries a real uuid yet
    // (items empty, mid-stream synthetic keys only, or optimistic echoes), do NOT fetch. An
    // anchorless request makes getConversation return the NEWEST window — the whole transcript
    // tail — which collides with the ws replay and renders the conversation twice / out of
    // order (fixed in d91fcf6, regressed by 0b8e106's zero-items exception, re-fixed here).
    // loadOlder serves strictly-older history; the newest window is owned by the ws replay,
    // and a ring with nothing renderable gets the server's `system/inactive` REST rescue
    // instead (ws/structured.ts hasRenderableEvents + the 'inactive' handler above). Bail and
    // let BootstrapOlderPages / a near-top scroll / the Load-earlier button retry once the
    // replay settles an anchor.
    // The bail RE-ARMS instead of dead-ending: it changes no other state, so without the flag
    // below nothing would ever re-fire paging and the Load-earlier button would stay visible
    // and inert forever (see anchorBlockedRef / anchorRetry above).
    if (firstCall && !beforeUuid) { anchorBlockedRef.current = true; return; }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    api.getConversation(terminalId, { before: oldestLineRef.current, ...(beforeUuid ? { beforeUuid } : {}), limit: OLDER_PAGE_LIMIT })
      .then((conv) => {
        if (tok !== pageTokenRef.current) return; // thread switched / ws reset mid-flight — discard
        oldestLineRef.current = conv.startLine;
        hasMoreRef.current = conv.hasMore;
        setHasMore(conv.hasMore);
        savedRef.current = { hasMore: conv.hasMore, oldestLine: conv.startLine };
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
            const seenUuids = new Set(prev.filter(hasRealUuid).map((it) => it.uuid as string));
            // The fingerprint set is built ONLY from already-rendered items that have no real
            // identity — that is what makes it the FALLBACK this comment always described.
            // Building it from every `prev` item (the old behaviour) meant a genuinely new
            // message was deleted merely because its rendered text matched something already on
            // screen, which is routine in a coding session: the same `Edit` result, the same
            // command re-run, two empty tool outputs, a repeated short user turn. Measured on
            // real transcripts that silently discarded 27-30% of paged history — the "history
            // skips lines" bug. `prev` also grows with every page, so it got worse the further
            // back you scrolled.
            // Scoped to items rendered BEFORE the oldest real identity: only those can
            // overlap an older page. Right after a respawn, the client's own echo of a
            // queued-while-working turn lands in the ring AHEAD of the first uuid'd live
            // event — the page then carries the transcript's uuid'd copy of that SAME
            // turn, which the uuid-only branch below used to prepend as a duplicate
            // (surviving every refresh, since both sources re-serve their copy). Anon
            // items at/after the anchor (the normal just-sent tail echo) must NOT
            // contribute: their transcript line is newer than the anchor, so a match
            // there is only ever a text coincidence with genuinely-older history (a
            // repeated "yes") — the measured "history skips lines" deletion class.
            const anchorIdx = prev.findIndex(hasRealUuid);
            const anonymousFingerprints = new Set(
              (anchorIdx < 0 ? prev : prev.slice(0, anchorIdx))
                .filter((it) => !hasRealUuid(it)).map(convItemFingerprint),
            );
            const fresh = conv.items.filter((it) =>
              // A real uuid IS the identity for uuid-vs-uuid dedup — but a pre-anchor
              // anon echo has no uuid to match, so the content fallback applies to
              // uuid'd page items too (it can only fire inside the pre-anchor window).
              hasRealUuid(it)
                ? !seenUuids.has(it.uuid as string) && !anonymousFingerprints.has(convItemFingerprint(it))
                : !anonymousFingerprints.has(convItemFingerprint(it)),
            );
            return fresh.length ? [...fresh, ...prev] : prev;
          });
        }
      })
      .catch(() => { /* transient — the next near-top scroll retries */ })
      .finally(() => {
        if (tok === pageTokenRef.current) { loadingOlderRef.current = false; setLoadingOlder(false); }
      });
    // `anchorRetry` is a dependency ON PURPOSE: bumping it re-creates this callback, which is
    // what re-fires useBootstrapOlderPages' effect after an anchorless bail (see above). The
    // body reads nothing from it.
  }, [terminalId, anchorRetry, setItems]);

  return {
    hasMore, loadingOlder, loadOlder, hydrateInactive,
    pageableRef, hasMoreRef, setHasMore, loadingOlderRef, setLoadingOlder, oldestLineRef, pageTokenRef,
    itemsRef, anchorBlockedRef, inactiveHydratedRef,
    // W3-D: the message journal (the socket module wires these to the socket)
    seqRef, noteEvent, resumeCursor, onJournalFrame,
  };
}
