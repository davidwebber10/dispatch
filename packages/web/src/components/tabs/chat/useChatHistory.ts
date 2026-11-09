import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ConvItem } from '../../../api/types';
import { api } from '../../../api/client';

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
  };
}
