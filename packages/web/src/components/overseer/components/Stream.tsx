// Overseer — ConversationStream (spec §6 "Conversation stream", §5 StreamMessage, §7, §8).
//
// Scrollable list of rv.stream, built on shadcn's MessageScroller chat primitive (the
// same one the agent ChatView uses). Renders four message variants:
//   isOverseer → left-aligned Dispatch turn (acc name + time header, then markdown body)
//   isUser     → right-aligned bubble (elev background, border, clipped top-right corner)
//   isImage    → left-aligned Dispatch turn whose body is a <ChatImage>
//   isNote     → centered accent pill (arrow-bend-down-right icon + text)
//
// Consecutive Dispatch turns (overseer + image) are grouped chat-app style: the "Dispatch"
// name+time header shows ONCE at the top of each run, not above every bubble.
//
// Scroll behaviour comes from the primitive, NOT a hand-rolled state machine:
//   • opens at the newest message (defaultScrollPosition="end")
//   • FOLLOWS a streaming reply — the primitive watches the viewport's CONTENT HEIGHT, so it
//     keeps pace as the last message's text grows (a count-based follow can't see this, since
//     streaming adds bytes without adding a message)
//   • a Scroll-to-Bottom button appears when the reader scrolls up, and they aren't yanked down
//   • StickToEndOnLoad re-sticks through the post-open backfill burst, re-arming per thread
//
// No prop drilling — reads the store directly.
// Desktop: flex:1 scroll (in the left conversation column). Mobile: fills the Stream tab.

import { useEffect, useRef } from 'react';
import { MessageScroller, useMessageScroller, useMessageScrollerScrollable } from '@shadcn/react/message-scroller';
import { CaretDoubleDown } from '@phosphor-icons/react';
import { Icon } from '../atoms';
import { Markdown } from '../../Markdown';
import { ChatImage } from '../../ChatImage';
import { WorkingIndicator } from '../../WorkingIndicator';
import { useOverseer, useRenderVals } from '../store';
import type { StreamMessage } from '../types';

// `.md-view`'s CSS consumes the GLOBAL `--color-*` tokens (defined on :root), which
// cascade into `.overseer-root` unchanged — that's why markdown renders correctly here
// with no overseer-specific CSS. The overseer's own `--tp`/`--acc`/`--elev` aliases hold
// identical values, but `.md-view` does NOT read them, so consolidating/renaming the
// overseer token set would not affect markdown rendering (don't assume it does).

// ---- Dispatch header (name + time) ------------------------------------------
// Shown once at the top of a run of consecutive Dispatch turns. Subsequent turns in the
// same run omit it (chat-app grouping) but keep the body left-aligned at the same x.

function DispatchHeader({ time }: { time: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--acc)' }}>Dispatch</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>{time}</span>
    </div>
  );
}

// ---- Overseer message -------------------------------------------------------

function OverseerMsg({ msg, showHeader }: { msg: StreamMessage; showHeader: boolean }) {
  if (!msg.text) return null; // parity with the agent AssistantText — no empty body
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
      {/* content column — fills the pane (no 64ch cap); side padding lives on Content */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
        {showHeader && <DispatchHeader time={msg.time} />}
        {/* body — markdown-rendered, parity with the agent assistant prose */}
        <div style={{ minWidth: 0 }}>
          <Markdown source={msg.text} />
        </div>
      </div>
    </div>
  );
}

// ---- Image message ----------------------------------------------------------
// Left-aligned on the coordinator's side (parity with OverseerMsg): a picture the
// coordinator surfaced — an agent/tool-emitted image, or one posted via `post_image`.
// The body is the shared <ChatImage>; src/alt are already resolved (data-URI or byte
// route) upstream in convItemsToStream, so this stays a dumb passthrough.

function ImageMsg({ msg, showHeader }: { msg: StreamMessage; showHeader: boolean }) {
  if (!msg.imageUrl) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
        {/* header — matches OverseerMsg so an image reads as a Dispatch turn (grouped) */}
        {showHeader && <DispatchHeader time={msg.time} />}
        {/* body — ChatImage caps its own height; left to fill the pane like prose */}
        <div style={{ minWidth: 0 }}>
          <ChatImage src={msg.imageUrl} alt={msg.imageAlt} />
        </div>
      </div>
    </div>
  );
}

// ---- User message -----------------------------------------------------------

function UserMsg({ msg }: { msg: StreamMessage }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: '72%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 4,
        }}
      >
        {/* time + "You" header — right-aligned, time first */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>{msg.time}</span>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ts)' }}>You</span>
        </div>
        {/* bubble — plain text (NOT markdown), parity with the agent UserBubble; a
            user's directive shows verbatim. pre-wrap keeps multi-line directives' breaks. */}
        <div
          style={{
            background: 'var(--elev)',
            border: '1px solid var(--border)',
            borderRadius: 11,
            borderTopRightRadius: 3,
            padding: '9px 13px',
            fontSize: 13.5,
            lineHeight: 1.55,
            color: 'var(--tp)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {msg.text}
        </div>
      </div>
    </div>
  );
}

// ---- Note pill (centered) ---------------------------------------------------

function NoteMsg({ msg }: { msg: StreamMessage }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '5px 12px',
          borderRadius: 20,
          background: 'var(--accDim)',
          border: '1px solid var(--accLine)',
          fontSize: 11.5,
          color: 'var(--ts)',
          maxWidth: '80%',
        }}
      >
        <Icon name="ph-arrow-bend-down-right" size={13} color="var(--acc)" />
        {msg.text}
      </span>
    </div>
  );
}

// ---- Stream rendering -------------------------------------------------------
// Walk the stream into MessageScroller.Items, grouping consecutive Dispatch turns
// (overseer + image) so the "Dispatch" header renders once per run. A user/note turn —
// or an empty overseer/image item that renders nothing — breaks the run. `prevDispatch`
// tracks the previously RENDERED row so a skipped (empty) item doesn't suppress the next
// real Dispatch header.

function renderStream(stream: StreamMessage[]) {
  const rows: React.ReactNode[] = [];
  let prevDispatch = false;

  for (const msg of stream) {
    if (msg.isOverseer) {
      if (!msg.text) continue; // renders nothing — don't push, don't touch the run
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <OverseerMsg msg={msg} showHeader={!prevDispatch} />
        </MessageScroller.Item>,
      );
      prevDispatch = true;
    } else if (msg.isImage) {
      if (!msg.imageUrl) continue;
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <ImageMsg msg={msg} showHeader={!prevDispatch} />
        </MessageScroller.Item>,
      );
      prevDispatch = true;
    } else if (msg.isUser) {
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <UserMsg msg={msg} />
        </MessageScroller.Item>,
      );
      prevDispatch = false;
    } else if (msg.isNote) {
      rows.push(
        <MessageScroller.Item key={msg.key} messageId={msg.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <NoteMsg msg={msg} />
        </MessageScroller.Item>,
      );
      prevDispatch = false;
    }
  }
  return rows;
}

// ---- ConversationStream (exported) ------------------------------------------

export function ConversationStream() {
  const { stream, busy } = useRenderVals();
  const coordinatorId = useOverseer((s) => s.coordinatorId);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MessageScroller.Provider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={48}>
        <MessageScroller.Root style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
          <MessageScroller.Viewport preserveScrollOnPrepend style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <MessageScroller.Content style={{ padding: '20px 26px 12px', display: 'flex', flexDirection: 'column', gap: 17 }}>
              {renderStream(stream)}
              {/* single indeterminate spinner while the coordinator works */}
              {busy && (
                <MessageScroller.Item messageId="__working" style={{ display: 'flex' }}>
                  <WorkingIndicator />
                </MessageScroller.Item>
              )}
            </MessageScroller.Content>
          </MessageScroller.Viewport>
          <JumpButton />
          <StickToEndOnLoad coordinatorId={coordinatorId} count={stream.length} />
        </MessageScroller.Root>
      </MessageScroller.Provider>
    </div>
  );
}

/**
 * Render-nothing helper: keep a freshly-opened (or freshly-switched) coordinator thread
 * pinned to the bottom through its post-mount backfill burst. The stream comes from the
 * same incremental useStructuredChat source as the agent chat, so on open it backfills as
 * a rapid 0→N append burst that can strand the viewport above the fold (a content change
 * can flip the scroller out of "following-bottom" before it catches up). We force
 * scrollToEnd('auto') — instant, so it never animates against the user — on each append
 * while still engaged, then hand off to native autoScroll the moment the user scrolls
 * off-tail. Mirrors the agent ChatView's StickToEndOnLoad, re-armed per coordinator thread.
 */
function StickToEndOnLoad({ coordinatorId, count }: { coordinatorId: string | null; count: number }) {
  const { scrollToEnd } = useMessageScroller();
  const { end } = useMessageScrollerScrollable(); // end === true ⇒ off-tail (content below the fold)
  const settledRef = useRef(false);
  const prevCountRef = useRef(-1);
  const termRef = useRef(coordinatorId);

  useEffect(() => {
    // New coordinator thread → re-arm so its own backfill re-sticks to the bottom.
    if (termRef.current !== coordinatorId) {
      termRef.current = coordinatorId;
      settledRef.current = false;
      prevCountRef.current = -1;
    }
    // `stream` only ever GROWS or RESETS-TO-EMPTY, so a count regression unambiguously means
    // the list was cleared/replaced (ws-reconnect replay, or a remount whose outgoing count
    // still sits in prevCountRef while the new backfill climbs from 0). Re-arm so the append
    // burst exceeds prevCount and re-sticks.
    if (count < prevCountRef.current) prevCountRef.current = -1;
    if (settledRef.current) return;
    if (count > prevCountRef.current) {
      // Backfill / live append while still engaged → snap to the bottom, even when `end`
      // reads off-tail: during the burst the viewport legitimately starts above the fold and
      // must be pulled down.
      prevCountRef.current = count;
      scrollToEnd({ behavior: 'auto' });
      return;
    }
    // Count held steady AND we're parked off-tail → the user scrolled up themselves.
    // Disengage for the rest of this thread; native autoScroll owns follow-while-pinned now.
    if (end) settledRef.current = true;
  }, [coordinatorId, count, end, scrollToEnd]);

  return null;
}

/** Floating "scroll to bottom" pill — shown only when the reader is off-tail. */
function JumpButton() {
  const { end } = useMessageScrollerScrollable();
  if (!end) return null;
  return (
    <MessageScroller.Button
      direction="end"
      style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 14,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 13px',
        borderRadius: 20,
        background: 'var(--acc)',
        color: '#06140B',
        border: 'none',
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        boxShadow: '0 8px 22px -6px rgba(0,0,0,.7)',
        cursor: 'pointer',
        zIndex: 5,
      }}
    >
      <CaretDoubleDown size={14} weight="bold" />
      Scroll to bottom
    </MessageScroller.Button>
  );
}
