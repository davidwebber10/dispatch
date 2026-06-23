import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Wrench, Brain, Terminal as TerminalIcon, CaretRight, MagnifyingGlass, X, ArrowUp } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { ConvItem, SearchMatch } from '../../api/types';
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
const LIMIT = 120; // jsonl lines per window (initial load + each older chunk)

export function ConversationView({ terminalId }: { terminalId: string }) {
  const [items, setItems] = useState<ConvItem[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const earliest = useRef(0);   // top edge (startLine) of the loaded window
  const pollCursor = useRef(0); // bottom edge (total lines) for polling new
  const ts = useThreadStatus((s) => s.byTerminal[terminalId]);
  const activityBusy = useActivity((s) => s.byTerminal[terminalId]?.activity === 'busy');
  const busy = ts ? ts.status === 'working' : activityBusy;
  const needsInput = ts?.status === 'needs_input';
  const activityLabel = ts?.activity || undefined;
  const busyRef = useRef(busy); busyRef.current = busy;

  const outer = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const atEnd = useRef(true);                              // window includes the latest line → poll appends
  const prependFromHeight = useRef<number | null>(null);   // scroll-preserve marker
  const pendingScroll = useRef<number | null>(null);       // line to scroll to after a jump
  const loadToken = useRef(0);                             // discards stale async loads (race guard)
  const wantPrevUser = useRef(false);                      // up-arrow waiting on an older page to continue
  const [highlight, setHighlight] = useState<number | null>(null);

  // --- search (bottom bar over the full history) -----------------------
  const [searchQ, setSearchQ] = useState('');
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const v = searchQ.trim();
    if (!v) { setResults([]); setSearching(false); return; }
    let on = true; setSearching(true);
    const t = setTimeout(async () => {
      try { const r = await api.searchConversation(terminalId, v); if (on) setResults(r.matches); }
      catch { if (on) setResults([]); }
      finally { if (on) setSearching(false); }
    }, 250);
    return () => { on = false; clearTimeout(t); };
  }, [searchQ, terminalId]);
  const goToResult = (line: number) => { setSearchQ(''); setResults([]); void loadAround(line); };

  // --- floating, draggable "jump to previous user message" arrow -------
  const arrowRef = useRef<HTMLButtonElement>(null);
  const [arrowPos, setArrowPos] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  // Load the most recent window (default View).
  async function loadInitial() {
    const tok = ++loadToken.current;
    try {
      const conv = await api.getConversation(terminalId, { limit: LIMIT });
      if (tok !== loadToken.current) return;
      if (conv.unsupported) { setUnsupported(true); setLoading(false); return; }
      setItems(conv.items); earliest.current = conv.startLine; pollCursor.current = conv.cursor;
      setHasMore(conv.hasMore); atEnd.current = true; setLoading(false);
    } catch { /* retried by the poll loop */ }
  }

  // Load a window centered on `line` (search jump), then scroll to it.
  async function loadAround(line: number) {
    const tok = ++loadToken.current;
    setLoading(true);
    try {
      const conv = await api.getConversation(terminalId, { before: line + Math.floor(LIMIT / 2), limit: LIMIT });
      if (tok !== loadToken.current) return;
      if (conv.unsupported) { setUnsupported(true); setLoading(false); return; }
      setItems(conv.items); earliest.current = conv.startLine; pollCursor.current = conv.cursor;
      setHasMore(conv.hasMore); atEnd.current = false; pendingScroll.current = line; setLoading(false);
    } catch { setLoading(false); }
  }

  // --- mount: load recent + poll for new messages at the bottom --------
  useEffect(() => {
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    setItems([]); setUnsupported(false); setHasMore(false); setLoading(true);
    earliest.current = 0; pollCursor.current = 0; atEnd.current = true;
    (async () => {
      await loadInitial();
      async function poll() {
        if (!on) return;
        if (atEnd.current) {
          const tok = loadToken.current;
          try {
            const conv = await api.getConversation(terminalId, { since: pollCursor.current });
            if (on && tok === loadToken.current) {
              if (conv.items.length) setItems((prev) => [...prev, ...conv.items]);
              pollCursor.current = conv.cursor;
            }
          } catch { /* transient */ }
        }
        if (on) timer = setTimeout(poll, busyRef.current ? 1000 : 2500);
      }
      if (on) timer = setTimeout(poll, busyRef.current ? 1000 : 2500);
    })();
    return () => { on = false; clearTimeout(timer); };
  }, [terminalId]);

  // Scroll up to the previous user message (the one just above the viewport).
  function scrollToPrevUser() {
    const el = scroller.current; if (!el) return;
    const elTop = el.getBoundingClientRect().top;
    const cur = el.scrollTop;
    let targetTop: number | null = null;
    el.querySelectorAll('[data-user="1"]').forEach((u) => {
      const top = (u as HTMLElement).getBoundingClientRect().top - elTop + cur;
      if (top < cur - 8) targetTop = top; // last user message above the current position
    });
    if (targetTop != null) { el.scrollTo({ top: Math.max(0, targetTop - 12), behavior: 'smooth' }); return; }
    // None loaded above: pull the next older page, reveal the loading indicator at
    // the top, and continue up to the message once it arrives (see the layout effect).
    if (hasMore) {
      wantPrevUser.current = true;
      el.scrollTo({ top: 0, behavior: 'smooth' });
      if (!loadingOlder) void loadOlder();
    }
  }

  function onArrowDown(e: React.PointerEvent) {
    const a = arrowRef.current, c = outer.current; if (!a || !c) return;
    const r = a.getBoundingClientRect(), cr = c.getBoundingClientRect();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: r.left - cr.left, oy: r.top - cr.top, moved: false };
    a.setPointerCapture(e.pointerId);
  }
  function onArrowMove(e: React.PointerEvent) {
    const d = drag.current, c = outer.current; if (!d || !c) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) d.moved = true;
    if (d.moved) {
      const cr = c.getBoundingClientRect();
      setArrowPos({ left: Math.max(6, Math.min(cr.width - 52, d.ox + dx)), top: Math.max(6, Math.min(cr.height - 52, d.oy + dy)) });
    }
  }
  function onArrowUp() {
    const d = drag.current; drag.current = null;
    if (d && !d.moved) scrollToPrevUser(); // a tap (not a drag) jumps to the previous user message
  }

  // --- load an older window when scrolled near the top -----------------
  async function loadOlder() {
    if (loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    const tok = loadToken.current;
    try {
      const conv = await api.getConversation(terminalId, { before: earliest.current, limit: LIMIT });
      if (tok === loadToken.current) {
        prependFromHeight.current = scroller.current?.scrollHeight ?? null; // preserve scroll
        earliest.current = conv.startLine;
        setHasMore(conv.hasMore);
        setItems((prev) => [...conv.items, ...prev]);
      }
    } catch { /* user can scroll to retry */ }
    setLoadingOlder(false);
  }

  // After items change: restore scroll on prepend, or jump+highlight on a search jump.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pendingScroll.current != null) {
      const line = pendingScroll.current; pendingScroll.current = null;
      let target = el.querySelector(`[data-line="${line}"]`) as HTMLElement | null;
      if (!target) {
        // nearest rendered item at or before the target line (the match may be
        // inside a merged tool card, which carries only the tool's line).
        let best: HTMLElement | null = null; let bestLine = -1;
        el.querySelectorAll('[data-line]').forEach((e) => {
          const l = Number((e as HTMLElement).getAttribute('data-line'));
          if (l <= line && l > bestLine) { bestLine = l; best = e as HTMLElement; }
        });
        target = best;
      }
      if (target) {
        target.scrollIntoView({ block: 'center' });
        const hl = Number(target.getAttribute('data-line'));
        setHighlight(hl);
        setTimeout(() => setHighlight((h) => (h === hl ? null : h)), 2200);
      }
    } else if (prependFromHeight.current != null) {
      el.scrollTop += el.scrollHeight - prependFromHeight.current;
      prependFromHeight.current = null;
      if (wantPrevUser.current) { wantPrevUser.current = false; scrollToPrevUser(); }
    }
  }, [items]);

  // --- auto-scroll to bottom on new items (only if already at bottom) ---
  useEffect(() => {
    if (atBottom.current && atEnd.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [items.length, busy]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (el.scrollTop < 120 && hasMore && !loadingOlder) void loadOlder();
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
    <div ref={outer} style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--color-base)' }}>
      <div ref={scroller} onScroll={onScroll} style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '18px 0' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 20px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {hasMore && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-tertiary)', fontSize: 12, padding: '4px 0' }}>
              {loadingOlder ? <><Spinner size={12} /> Loading earlier…</> : 'Scroll up for earlier messages'}
            </div>
          )}
          {items.length === 0 && !hasMore && (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '8px 0' }}>No messages yet. Switch to Terminal to interact.</div>
          )}
          {(() => {
            const rows: React.ReactNode[] = [];
            for (let i = 0; i < items.length; i++) {
              const it = items[i];
              const key = earliest.current + i;
              let node: React.ReactNode;
              if (it.kind === 'tool') {
                const next = items[i + 1];
                const result = next?.kind === 'tool-result' ? next : undefined;
                node = <ToolCall tool={it} result={result} />;
                if (result) i++;
              } else if (it.kind === 'tool-result') {
                node = <ToolResult item={it} />;
              } else {
                node = <Item item={it} />;
              }
              const hot = highlight != null && it.line === highlight;
              rows.push(
                <div key={key} data-line={it.line} data-user={it.kind === 'user' ? '1' : undefined}
                  style={{ display: 'flex', flexDirection: 'column', transition: 'background .4s, box-shadow .4s', ...(hot ? { borderRadius: 8, background: 'rgba(245,197,66,.14)', boxShadow: '0 0 0 3px rgba(245,197,66,.18)' } : {}) }}>
                  {node}
                </div>,
              );
            }
            return rows;
          })()}
          {busy && <Typing label={activityLabel} />}
          {!busy && needsInput && <NeedsInput label={activityLabel} />}
        </div>
      </div>

      {/* Floating, draggable "jump to previous user message" arrow. */}
      <button
        ref={arrowRef}
        onPointerDown={onArrowDown}
        onPointerMove={onArrowMove}
        onPointerUp={onArrowUp}
        title="Jump to previous message"
        style={{
          position: 'absolute', ...(arrowPos ? { left: arrowPos.left, top: arrowPos.top } : { right: 16, bottom: 88 }),
          width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--color-elevated)', border: '1px solid #2c2c32', color: 'var(--color-text-secondary)',
          boxShadow: '0 6px 18px -6px rgba(0,0,0,.6)', cursor: 'pointer', touchAction: 'none', zIndex: 4,
        }}
      >
        <ArrowUp size={18} weight="bold" />
      </button>

      {/* Search results (over the full history) */}
      {searchQ.trim() && (
        <div style={{ flexShrink: 0, maxHeight: '42vh', overflowY: 'auto', borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
          {searching && results.length === 0 && <div style={{ padding: '10px 14px', color: 'var(--color-text-tertiary)', fontSize: 13 }}>Searching…</div>}
          {!searching && results.length === 0 && <div style={{ padding: '10px 14px', color: 'var(--color-text-tertiary)', fontSize: 13 }}>No matches.</div>}
          {results.map((m, i) => (
            <button key={i} onClick={() => goToResult(m.line)} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)', padding: '9px 14px', cursor: 'pointer' }}>
              <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--color-text-tertiary)' }}>{m.kind}</span>
              <div style={{ fontSize: 13.5, color: 'var(--color-text-primary)', marginTop: 2, lineHeight: 1.45, wordBreak: 'break-word' }}>{m.snippet}</div>
            </button>
          ))}
        </div>
      )}

      {/* Search bar (bottom) */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', padding: '8px 12px', paddingBottom: 'calc(8px + env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', gap: 8 }}>
        <MagnifyingGlass size={15} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
        <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search this conversation…"
          style={{ flex: 1, minWidth: 0, background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 8, color: 'var(--color-text-primary)', font: '400 13px var(--font-sans)', padding: '8px 10px', outline: 'none' }} />
        {searchQ && <button onClick={() => { setSearchQ(''); setResults([]); }} title="Clear" style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', display: 'flex', flexShrink: 0 }}><X size={15} /></button>}
      </div>
    </div>
  );
}

function Item({ item }: { item: ConvItem }) {
  if (item.kind === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '88%', background: 'var(--color-accent)', borderRadius: '14px 14px 4px 14px', padding: '9px 13px', fontSize: 13.5, fontWeight: 500, lineHeight: 1.55, color: '#08240F', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
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

/** A tool call: tool name (row 1) + file/detail (row 2), expandable to its output. */
function ToolCall({ tool, result }: { tool: ConvItem; result?: ConvItem }) {
  const [open, setOpen] = useState(false);
  const name = tool.toolTitle ?? tool.toolName ?? 'Tool';
  const detail = tool.toolDetail;
  const out = result?.text ?? '';
  const hasOut = !!out.trim();
  const err = result?.isError;
  const lines = hasOut ? out.split('\n').length : 0;
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 9, background: 'var(--color-elevated)', overflow: 'hidden' }}>
      <button
        onClick={() => hasOut && setOpen((o) => !o)}
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: hasOut ? 'pointer' : 'default', padding: '8px 10px', display: 'flex', gap: 8, alignItems: 'flex-start' }}
      >
        <CaretRight size={11} weight="bold" style={{ marginTop: 2, flexShrink: 0, color: 'var(--color-text-tertiary)', visibility: hasOut ? 'visible' : 'hidden', transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
        <Wrench size={13} color="#5A8DD6" style={{ marginTop: 1, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--color-text-primary)', fontWeight: 500 }}>
            <span>{name}</span>
            {result && <span style={{ fontWeight: 400, fontSize: 11, color: err ? 'var(--color-status-red)' : 'var(--color-text-tertiary)' }}>{err ? 'error' : `${lines} line${lines !== 1 ? 's' : ''}`}</span>}
          </div>
          {detail && <div style={{ marginTop: 2, font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</div>}
        </div>
      </button>
      {open && hasOut && (
        <pre style={{ margin: 0, borderTop: '1px solid var(--color-border)', font: '400 11.5px var(--font-mono)', lineHeight: 1.5, color: err ? 'var(--color-status-red)' : 'var(--color-text-tertiary)', padding: '8px 10px', maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{out}</pre>
      )}
    </div>
  );
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
