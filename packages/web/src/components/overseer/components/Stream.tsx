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
import { useRenderVals } from '../store';
import type { StreamMessage } from '../types';

// ---- Overseer message -------------------------------------------------------

function OverseerMsg({ msg }: { msg: StreamMessage }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
      {/* broadcast avatar 24×24 */}
      <div
        style={{
          flex: 'none',
          width: 24,
          height: 24,
          borderRadius: 7,
          background: 'linear-gradient(150deg,#1b3a26,#0f1f16)',
          border: '1px solid var(--accLine)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--acc)',
        }}
      >
        <Icon name="ph-broadcast" weight="fill" size={12} />
      </div>

      {/* content column */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        {/* name + time header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--acc)' }}>Overseer</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>{msg.time}</span>
        </div>
        {/* body */}
        <p
          style={{
            margin: 0,
            fontSize: 13.5,
            lineHeight: 1.55,
            color: 'var(--tp)',
            maxWidth: '64ch',
          }}
        >
          {msg.text}
        </p>
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
        {/* bubble */}
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
  const { stream } = useRenderVals();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom whenever a new message arrives.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [stream.length]);

  return (
    <div
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
      {/* sentinel — scrolled into view on new messages */}
      <div ref={bottomRef} style={{ flex: 'none', height: 0 }} />
    </div>
  );
}
