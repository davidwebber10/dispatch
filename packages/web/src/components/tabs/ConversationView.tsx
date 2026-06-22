import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Stop, Wrench, Brain, Terminal as TerminalIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { ConvItem } from '../../api/types';
import { useActivity } from '../../stores/activity';
import { renderMarkdown } from '../../lib/markdown';

/**
 * Normal Mode: a chat-style render of the session's live transcript. Reads are
 * cursor-polled from the daemon; the composer writes back to the SAME live PTY
 * (so Expert Mode mirrors it). Stop interrupts the turn; sending while the agent
 * is responding queues the message and auto-sends it when the turn finishes.
 */
export function ConversationView({ terminalId }: { terminalId: string }) {
  const [items, setItems] = useState<ConvItem[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [input, setInput] = useState('');
  const [queued, setQueued] = useState<string[]>([]);
  const cursor = useRef(0);
  const busy = useActivity((s) => s.byTerminal[terminalId]?.activity === 'busy');
  const busyRef = useRef(busy); busyRef.current = busy;
  const prevBusy = useRef(busy);

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const refreshRef = useRef<() => void>(() => {});

  // --- cursor-polling of the transcript --------------------------------
  useEffect(() => {
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    setItems([]); setUnsupported(false); cursor.current = 0;
    async function refresh() {
      try {
        const conv = await api.getConversation(terminalId, cursor.current);
        if (!on) return;
        if (conv.unsupported) { setUnsupported(true); on = false; return; }
        if (conv.items.length) setItems((prev) => [...prev, ...conv.items]);
        cursor.current = conv.cursor;
      } catch { /* transient; retry next tick */ }
    }
    async function loop() {
      await refresh();
      if (on) timer = setTimeout(loop, busyRef.current ? 1000 : 2500);
    }
    refreshRef.current = () => { void refresh(); };
    void loop();
    return () => { on = false; clearTimeout(timer); };
  }, [terminalId]);

  // --- auto-scroll to bottom on new items ------------------------------
  useEffect(() => {
    if (atBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [items.length, busy]);

  // --- flush one queued message when a turn finishes (busy true->false) -
  useEffect(() => {
    const was = prevBusy.current; prevBusy.current = busy;
    if (was && !busy && queued.length) {
      const [next, ...rest] = queued;
      setQueued(rest);
      void api.sendInput(terminalId, next + '\r').then(() => setTimeout(() => refreshRef.current(), 300));
    }
  }, [busy, queued, terminalId]);

  function onScroll() {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  function send() {
    const msg = input.trim();
    if (!msg) return;
    setInput('');
    if (busy) { setQueued((q) => [...q, msg]); return; }
    atBottom.current = true;
    void api.sendInput(terminalId, msg + '\r').then(() => setTimeout(() => refreshRef.current(), 300));
  }

  function stop() { void api.sendInput(terminalId, '\x1b'); } // Esc interrupts the turn

  if (unsupported) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-tertiary)', padding: 24, textAlign: 'center' }}>
        <TerminalIcon size={22} />
        <div style={{ fontSize: 13 }}>Normal Mode isn't available for this thread yet.</div>
        <div style={{ fontSize: 12 }}>Switch to <strong style={{ color: 'var(--color-text-secondary)' }}>Expert</strong> for the terminal.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--color-base)' }}>
      <div ref={scroller} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 0' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {items.length === 0 && (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '8px 0' }}>No messages yet — say something below.</div>
          )}
          {items.map((it, i) => <Item key={i} item={it} />)}
          {busy && <Typing />}
        </div>
      </div>

      {/* Composer */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', padding: '10px 16px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {queued.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {queued.map((q, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', font: '400 11.5px var(--font-mono)', color: 'var(--color-status-yellow)', background: 'rgba(245,197,66,.1)', border: '1px solid rgba(245,197,66,.3)', borderRadius: 7, padding: '3px 8px' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>queued: {q}</span>
                  <button onClick={() => setQueued((qq) => qq.filter((_, j) => j !== i))} title="Remove" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={1}
              placeholder={busy ? 'Queue a follow-up…' : 'Message…  (Enter to send, Shift+Enter for newline)'}
              style={{ flex: 1, minWidth: 0, resize: 'none', maxHeight: 160, minHeight: 38, padding: '9px 12px', background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 10, color: 'var(--color-text-primary)', font: '400 13px var(--font-sans)', lineHeight: 1.5 }}
            />
            {busy && (
              <button onClick={stop} title="Stop (interrupt the current turn)" style={{ flexShrink: 0, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#241313', border: '1px solid #4A1F22', borderRadius: 10, color: '#F0616D', cursor: 'pointer' }}>
                <Stop size={16} weight="fill" />
              </button>
            )}
            <button onClick={send} disabled={!input.trim()} title={busy ? 'Queue message' : 'Send'} style={{ flexShrink: 0, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', background: input.trim() ? 'var(--color-accent)' : 'var(--color-elevated)', border: input.trim() ? 'none' : '1px solid #2c2c32', borderRadius: 10, color: input.trim() ? '#08240F' : 'var(--color-text-tertiary)', cursor: input.trim() ? 'pointer' : 'default' }}>
              <ArrowUp size={17} weight="bold" />
            </button>
          </div>
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
  return (
    <pre style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, color: item.isError ? 'var(--color-status-red)' : 'var(--color-text-tertiary)', background: 'var(--color-elevated)', border: `1px solid ${item.isError ? 'rgba(240,97,109,.3)' : 'var(--color-border)'}`, borderRadius: 8, padding: '8px 10px', maxHeight: 140, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.text}</pre>
  );
}

function Typing() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-accent)', fontSize: 12.5 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)', animation: 'dispatchPulse 1.4s ease-in-out infinite' }} />
      Working…
    </div>
  );
}
