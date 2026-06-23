import { useEffect, useRef, useState } from 'react';
import { Wrench, Brain, Terminal as TerminalIcon, CaretRight } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { ConvItem } from '../../api/types';
import { useActivity } from '../../stores/activity';
import { useThreadStatus } from '../../stores/threadStatus';
import { Spinner } from '../common/Spinner';
import { renderMarkdown } from '../../lib/markdown';

/**
 * View mode: a READ-ONLY, chat-style render of the session's live transcript
 * (cursor-polled from the daemon). All interaction happens in Terminal mode —
 * View never writes to the PTY. It shows working / needs-input status purely as
 * indicators so you can watch a thread without driving it.
 */
export function ConversationView({ terminalId }: { terminalId: string }) {
  const [items, setItems] = useState<ConvItem[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const cursor = useRef(0);
  const TAIL = 600; // initial-load line cap — enough recent context, loads fast
  const ts = useThreadStatus((s) => s.byTerminal[terminalId]);
  const activityBusy = useActivity((s) => s.byTerminal[terminalId]?.activity === 'busy');
  const busy = ts ? ts.status === 'working' : activityBusy;
  const needsInput = ts?.status === 'needs_input';
  const activityLabel = ts?.activity || undefined;
  const busyRef = useRef(busy); busyRef.current = busy;

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // --- cursor-polling of the transcript (read-only) --------------------
  useEffect(() => {
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    setItems([]); setUnsupported(false); setTruncated(false); setLoading(true); cursor.current = 0;
    async function refresh() {
      try {
        // First load only pulls the recent tail (fast); afterwards, just new lines.
        const conv = await api.getConversation(terminalId, cursor.current, cursor.current === 0 ? TAIL : 0);
        if (!on) return;
        if (conv.unsupported) { setUnsupported(true); setLoading(false); on = false; return; }
        if (cursor.current === 0) { setItems(conv.items); setTruncated(!!conv.truncated); }
        else if (conv.items.length) setItems((prev) => [...prev, ...conv.items]);
        cursor.current = conv.cursor;
        setLoading(false);
      } catch { /* transient; retry next tick */ }
    }
    async function loop() {
      await refresh();
      if (on) timer = setTimeout(loop, busyRef.current ? 1000 : 2500);
    }
    void loop();
    return () => { on = false; clearTimeout(timer); };
  }, [terminalId]);

  // Load the full transcript on demand (when the initial tail was truncated).
  async function loadEarlier() {
    try {
      const conv = await api.getConversation(terminalId, 0, 0);
      setItems(conv.items);
      setTruncated(false);
      cursor.current = conv.cursor;
    } catch { /* ignore; user can retry */ }
  }

  // --- auto-scroll to bottom on new items ------------------------------
  useEffect(() => {
    if (atBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [items.length, busy]);

  function onScroll() {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  if (unsupported) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-tertiary)', padding: 24, textAlign: 'center' }}>
        <TerminalIcon size={22} />
        <div style={{ fontSize: 13 }}>View isn't available for this thread yet.</div>
        <div style={{ fontSize: 12 }}>Switch to <strong style={{ color: 'var(--color-text-secondary)' }}>Terminal</strong> to use it.</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, color: 'var(--color-text-tertiary)', background: 'var(--color-base)', fontSize: 13 }}>
        <Spinner size={14} /> Loading conversation…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--color-base)' }}>
      <div ref={scroller} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 0' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {items.length === 0 && (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '8px 0' }}>No messages yet. Switch to Terminal to interact.</div>
          )}
          {truncated && (
            <button onClick={() => void loadEarlier()} style={{ alignSelf: 'center', background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 8, color: 'var(--color-text-secondary)', fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}>
              Load earlier messages
            </button>
          )}
          {items.map((it, i) => <Item key={i} item={it} />)}
          {busy && <Typing label={activityLabel} />}
          {!busy && needsInput && <NeedsInput label={activityLabel} />}
        </div>
      </div>
    </div>
  );
}

function Item({ item }: { item: ConvItem }) {
  if (item.kind === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '85%', background: 'var(--color-hover)', border: '1px solid var(--color-border)', borderRadius: '12px 12px 4px 12px', padding: '9px 13px', fontSize: 13, lineHeight: 1.55, color: 'var(--color-text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {item.text}
      </div>
    );
  }
  if (item.kind === 'assistant') {
    return <div className="md-view" style={{ fontSize: 13.5 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text ?? '') }} />;
  }
  if (item.kind === 'thinking') {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: 'var(--color-text-tertiary)', borderLeft: '2px solid var(--color-border)', paddingLeft: 10 }}>
        <Brain size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 12, fontStyle: 'italic', lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 88, overflow: 'hidden' }}>{item.text || 'Thinking…'}</div>
      </div>
    );
  }
  if (item.kind === 'tool') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, font: '400 12px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
        <Wrench size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />
        <span style={{ color: 'var(--color-text-primary)' }}>{item.toolTitle ?? item.toolName}</span>
        {item.toolDetail && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-tertiary)' }}>{item.toolDetail}</span>}
      </div>
    );
  }
  // tool-result
  return <ToolResult item={item} />;
}

/** A tool result, minimized to a one-line summary and expandable on click. */
function ToolResult({ item }: { item: ConvItem }) {
  const [open, setOpen] = useState(false);
  const text = item.text ?? '';
  if (!text.trim()) return null;
  const lines = text.split('\n').length;
  const err = item.isError;
  const color = err ? 'var(--color-status-red)' : 'var(--color-text-tertiary)';
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: '1px 0', font: '400 11.5px var(--font-mono)', color }}
      >
        <CaretRight size={10} weight="bold" style={{ transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
        {err ? 'Error output' : 'Output'}<span style={{ opacity: 0.6 }}> · {lines} line{lines !== 1 ? 's' : ''}</span>
      </button>
      {open && (
        <pre style={{ margin: '4px 0 0', font: '400 11.5px var(--font-mono)', lineHeight: 1.5, color, background: 'var(--color-elevated)', border: `1px solid ${err ? 'rgba(240,97,109,.3)' : 'var(--color-border)'}`, borderRadius: 8, padding: '8px 10px', maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</pre>
      )}
    </div>
  );
}

function Typing({ label }: { label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-accent)', fontSize: 12.5 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)', animation: 'dispatchPulse 1.4s ease-in-out infinite' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || 'Working…'}</span>
    </div>
  );
}

function NeedsInput({ label }: { label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-status-yellow)', fontSize: 12.5 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-status-yellow)', animation: 'dispatchGlow 1.6s ease-in-out infinite' }} />
      {label || 'Waiting for your input (use Terminal)'}
    </div>
  );
}
