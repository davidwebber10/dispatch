// Overseer — ConversationStream (spec §6 "Conversation stream", §5 StreamMessage, §7, §8).
//
// Scrollable list of rv.stream. Renders three message variants:
//   isOverseer → left-aligned avatar + body (broadcast avatar, acc name + time, body max-width 64ch)
//   isUser     → right-aligned bubble (elev background, border, clipped top-right corner)
//   isNote     → centered accent pill (arrow-bend-down-right icon + text)
//
// Auto-scrolls to bottom whenever the stream grows. No prop drilling — reads the store directly.
// Desktop: flex:1 scroll (in the left conversation column).
// Mobile:  fills the Stream tab above the Composer (same flex:1 container; parent provides height).

import { useEffect, useRef } from 'react';
import { Icon } from '../atoms';
import { Markdown } from '../../Markdown';
import { WorkingIndicator } from '../../WorkingIndicator';
import { useRenderVals } from '../store';
import type { StreamMessage } from '../types';

// `.md-view`'s CSS consumes the GLOBAL `--color-*` tokens (defined on :root), which
// cascade into `.overseer-root` unchanged — that's why markdown renders correctly here
// with no overseer-specific CSS. The overseer's own `--tp`/`--acc`/`--elev` aliases hold
// identical values, but `.md-view` does NOT read them, so consolidating/renaming the
// overseer token set would not affect markdown rendering (don't assume it does).

// ---- Overseer message -------------------------------------------------------

function OverseerMsg({ msg }: { msg: StreamMessage }) {
  if (!msg.text) return null; // parity with the agent AssistantText — no empty 64ch body
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
      {/* content column */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        {/* name + time header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--acc)' }}>Dispatch</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>{msg.time}</span>
        </div>
        {/* body — markdown-rendered, parity with the agent assistant prose */}
        <div style={{ maxWidth: '64ch', minWidth: 0 }}>
          <Markdown source={msg.text} />
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

// ---- ConversationStream (exported) ------------------------------------------

export function ConversationStream() {
  const { stream, busy } = useRenderVals();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Follow the conversation ONLY when the user is already parked at the bottom — an
  // unconditional scrollIntoView would yank a user who has scrolled up to read.
  // "Pinned" = within ~48px of the bottom (matches the agent chat's scrollEdgeThreshold).
  // Re-runs on a new message and on the busy toggle (so the WorkingIndicator stays in view).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (pinned) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [stream.length, busy]);

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '20px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 17,
      }}
    >
      {stream.map((msg) => {
        if (msg.isOverseer) return <OverseerMsg key={msg.key} msg={msg} />;
        if (msg.isUser) return <UserMsg key={msg.key} msg={msg} />;
        if (msg.isNote) return <NoteMsg key={msg.key} msg={msg} />;
        return null;
      })}
      {/* single indeterminate spinner while the coordinator works — last child, before the sentinel */}
      {busy && <WorkingIndicator />}
      {/* sentinel — scrolled into view on new messages (only while pinned) */}
      <div ref={bottomRef} style={{ flex: 'none', height: 0 }} />
    </div>
  );
}
