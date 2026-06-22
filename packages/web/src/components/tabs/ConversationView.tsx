import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Stop, Wrench, Brain, Terminal as TerminalIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { ConvItem } from '../../api/types';
import { useActivity } from '../../stores/activity';
import { useThreadStatus } from '../../stores/threadStatus';
import { PromptCard } from './PromptCard';
import { renderMarkdown } from '../../lib/markdown';

/**
 * Visual mode: a chat-style render of the session's live transcript. Reads are
 * cursor-polled from the daemon; the composer writes back to the SAME live PTY
 * (so Terminal mode mirrors it). Stop interrupts the turn; a message is always
 * sent straight to the agent, which runs it now if idle or queues it natively if
 * mid-turn (no client-side queue — that caused staged/lost messages).
 */
export function ConversationView({ terminalId }: { terminalId: string }) {
  const [items, setItems] = useState<ConvItem[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [input, setInput] = useState('');
  const [showAll, setShowAll] = useState(false);
  const cursor = useRef(0);
  // Prefer the hook/notify-driven status (accurate per-turn); fall back to the
  // PTY activity heuristic only until the first status event arrives.
  const ts = useThreadStatus((s) => s.byTerminal[terminalId]);
  const activityBusy = useActivity((s) => s.byTerminal[terminalId]?.activity === 'busy');
  const busy = ts ? ts.status === 'working' : activityBusy;
  const needsInput = ts?.status === 'needs_input';
  const activityLabel = ts?.activity || undefined;
  const busyRef = useRef(busy); busyRef.current = busy;

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

  function onScroll() {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  function send() {
    const msg = input.trim();
    if (!msg) return;
    setInput('');
    atBottom.current = true;
    // Always send straight to the agent. It runs the message immediately when
    // idle and queues it natively when mid-turn — so there's no client-side
    // queue to drop or mis-flush (the old source of staged/lost messages).
    void api.sendInput(terminalId, msg + '\r').then(() => setTimeout(() => refreshRef.current(), 300));
  }

  function stop() { void api.sendInput(terminalId, '\x1b'); } // Esc interrupts the turn

  if (unsupported) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-tertiary)', padding: 24, textAlign: 'center' }}>
        <TerminalIcon size={22} />
        <div style={{ fontSize: 13 }}>Visual view isn't available for this thread yet.</div>
        <div style={{ fontSize: 12 }}>Switch to <strong style={{ color: 'var(--color-text-secondary)' }}>Terminal</strong> to use it.</div>
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
          {(() => {
            const MAX = 120;
            const hidden = showAll ? 0 : Math.max(0, items.length - MAX);
            const base = hidden;
            const shown = hidden ? items.slice(hidden) : items;
            return (
              <>
                {hidden > 0 && (
                  <button onClick={() => setShowAll(true)} style={{ alignSelf: 'center', background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 8, color: 'var(--color-text-secondary)', fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}>
                    Show {hidden} earlier message{hidden > 1 ? 's' : ''}
                  </button>
                )}
                {shown.map((it, i) => <Item key={base + i} item={it} />)}
              </>
            );
          })()}
          {busy && <Typing label={activityLabel} />}
          {!busy && needsInput && <NeedsInput label={activityLabel} />}
        </div>
      </div>

      {/* Composer */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', padding: '10px 16px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <PromptCard terminalId={terminalId} />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={1}
              placeholder={busy ? 'Message…  (sends now, agent queues it)' : 'Message…  (Enter to send, Shift+Enter for newline)'}
              style={{ flex: 1, minWidth: 0, resize: 'none', maxHeight: 160, minHeight: 38, padding: '9px 12px', background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 10, color: 'var(--color-text-primary)', font: '400 13px var(--font-sans)', lineHeight: 1.5 }}
            />
            {busy && (
              <button onClick={stop} title="Stop (interrupt the current turn)" style={{ flexShrink: 0, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#241313', border: '1px solid #4A1F22', borderRadius: 10, color: '#F0616D', cursor: 'pointer' }}>
                <Stop size={16} weight="fill" />
              </button>
            )}
            <button onClick={send} disabled={!input.trim()} title="Send" style={{ flexShrink: 0, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', background: input.trim() ? 'var(--color-accent)' : 'var(--color-elevated)', border: input.trim() ? 'none' : '1px solid #2c2c32', borderRadius: 10, color: input.trim() ? '#08240F' : 'var(--color-text-tertiary)', cursor: input.trim() ? 'pointer' : 'default' }}>
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
      {label || 'Waiting for your input'}
    </div>
  );
}
