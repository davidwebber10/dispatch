import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Wrench, Brain, Terminal as TerminalIcon, MagnifyingGlass, X, ArrowUp, CaretDoubleDown, Paperclip, PaperPlaneTilt, Sparkle } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { ConvItem, SearchMatch } from '../../api/types';
import { useStructuredStream } from './useStructuredStream';
import { useActivity } from '../../stores/activity';
import { useThreadStatus } from '../../stores/threadStatus';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useThreadMode } from '../../stores/threadMode';
import { useUI } from '../../stores/ui';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useDraft } from '../../hooks/useDraft';
import { Spinner } from '../common/Spinner';
import { renderMarkdown } from '../../lib/markdown';
import { ToolCall, ToolResult } from './ToolCall';

/**
 * View mode: a READ-ONLY, chat-style render of the session's live transcript
 * (cursor-polled from the daemon). All interaction happens in Terminal mode —
 * View never writes to the PTY. It shows working / needs-input status purely as
 * indicators so you can watch a thread without driving it.
 */
const LIMIT = 120; // jsonl lines per window (initial load + each older chunk)

export function ConversationView({ terminalId }: { terminalId: string }) {
  const isMobile = useIsMobile(); // desktop floats the View/Terminal toggle over the top-right
  const tab = useTabs((s) => findTerminal(s.byProject, terminalId));
  const structured = (tab?.config as any)?.transport === 'structured';

  // Structured path: live items from the ws stream (no polling).
  const liveItems = useStructuredStream(structured ? terminalId : '');

  const [items, setItems] = useState<ConvItem[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(!structured);
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

  // --- search (full-width bar below the header, over the full history) --
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
  const [grabbed, setGrabbed] = useState(false); // press-down visual cue (enlarge + wiggle)
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  // --- "scroll to latest" down-arrow (mirrors Terminal) ---------------
  const [showDown, setShowDown] = useState(false);
  async function scrollToLatest() {
    if (!atEnd.current) { atBottom.current = true; setShowDown(false); await loadInitial(); return; } // effect scrolls to bottom
    const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setShowDown(false);
  }

  // --- compose box → hand off to Terminal (View never writes to View) --
  const sessionId = tab?.sessionId;
  const setMode = useThreadMode((s) => s.set);
  const [composeText, setComposeText, clearComposeText] = useDraft(terminalId);
  const [note, setNote] = useState('');
  function sendToTerminal() {
    const v = composeText.trim();
    if (!v) return;
    if (structured) {
      // Structured transport: POST text directly; do NOT switch to Terminal mode.
      void api.sendStructuredMessage(terminalId, v);
      clearComposeText();
    } else {
      // PTY path: Send text + Enter as SEPARATE writes (see TerminalTab.sendMobileInput).
      void api.sendInput(terminalId, v);
      setTimeout(() => void api.sendInput(terminalId, '\r'), 80);
      clearComposeText();
      setMode(terminalId, 'expert'); // switch to Terminal so you watch it run
    }
  }
  async function attachFiles(files: FileList | null) {
    if (!files || !files.length || !sessionId) return;
    for (const f of Array.from(files)) {
      setNote(`Uploading ${f.name}…`);
      try { const res = await api.uploadInbox(sessionId, f); await api.sendFileReference(terminalId, res.path, 'agent-context'); setNote(`Sent ${f.name}`); }
      catch { setNote('Upload failed'); }
    }
    setTimeout(() => setNote(''), 2500);
    setMode(terminalId, 'expert');
  }

  // --- open a tool-call's file in the file viewer (a 'file' tab) --------
  async function openFileInViewer(path: string) {
    if (!sessionId) return;
    const st = useTabs.getState();
    const existing = (st.byProject[sessionId] ?? []).find((t) => t.type === 'file' && (t.config?.path as string) === path);
    let id = existing?.id;
    if (!id) {
      try {
        const name = path.split('/').pop() || path;
        const t = await api.createTerminal(sessionId, { type: 'file', label: name, config: { path } });
        await st.loadTabs(sessionId);
        id = t.id;
      } catch { setNote('Could not open file'); setTimeout(() => setNote(''), 2500); return; }
    }
    st.openTab(id);                    // desktop: switch the active tab
    useUI.getState().requestOpenTab(id); // mobile: MobileApp navigates its leaf
  }

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
  // Skipped entirely for structured threads (live ws stream via useStructuredStream).
  useEffect(() => {
    if (structured) return;
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
  }, [terminalId, structured]);

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
    setGrabbed(true); // enlarge + wiggle to signal "drag me"
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
    setGrabbed(false);
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
        setShowDown(true); // jumped off the live tail
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
  const displayLen = structured ? liveItems.length : items.length;
  useEffect(() => {
    if (atBottom.current && atEnd.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [displayLen, busy]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setShowDown(!atBottom.current || !atEnd.current); // off the live tail → show the jump-down arrow
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

  // Structured threads render from the live ws stream; polled threads use the local `items` state.
  const displayItems = structured ? liveItems : items;

  return (
    <div ref={outer} style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--color-base)' }}>
      {/* Full-width search, just below the header. Matches show in a dropdown that
          overlays the top of the transcript; tapping one jumps + clears. */}
      <div style={{ position: 'relative', flexShrink: 0, zIndex: 8, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', paddingRight: isMobile ? 12 : 118, borderBottom: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
        <MagnifyingGlass size={15} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
        <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search this conversation…"
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          style={{ flex: 1, minWidth: 0, height: 32, background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 16, padding: '0 10px', outline: 'none' }} />
        {searchQ && <button onClick={() => { setSearchQ(''); setResults([]); }} title="Clear" style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', display: 'flex', flexShrink: 0 }}><X size={16} /></button>}
        {searchQ.trim() && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, maxHeight: '52vh', overflowY: 'auto', background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)', boxShadow: '0 14px 26px -10px rgba(0,0,0,.6)' }}>
            {searching && results.length === 0 && <div style={{ padding: '11px 14px', color: 'var(--color-text-tertiary)', fontSize: 13 }}>Searching…</div>}
            {!searching && results.length === 0 && <div style={{ padding: '11px 14px', color: 'var(--color-text-tertiary)', fontSize: 13 }}>No matches.</div>}
            {results.map((m, i) => (
              <button key={i} onClick={() => goToResult(m.line)} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)', padding: '10px 14px', cursor: 'pointer' }}>
                <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--color-text-tertiary)' }}>{m.kind}</span>
                <div style={{ fontSize: 13.5, color: 'var(--color-text-primary)', marginTop: 2, lineHeight: 1.45, wordBreak: 'break-word' }}>{m.snippet}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      <div ref={scroller} onScroll={onScroll} style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '18px 0' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 20px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {hasMore && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-text-tertiary)', fontSize: 12, padding: '4px 0' }}>
              {loadingOlder ? <><Spinner size={12} /> Loading earlier…</> : 'Scroll up for earlier messages'}
            </div>
          )}
          {displayItems.length === 0 && !hasMore && (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '8px 0' }}>No messages yet. Switch to Terminal to interact.</div>
          )}
          {(() => {
            const rows: React.ReactNode[] = [];
            for (let i = 0; i < displayItems.length; i++) {
              const it = displayItems[i];
              const key = earliest.current + i;
              let node: React.ReactNode;
              if (it.kind === 'tool') {
                const next = displayItems[i + 1];
                const result = next?.kind === 'tool-result' ? next : undefined;
                node = <ToolCall tool={it} result={result} onViewFile={openFileInViewer} />;
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

      {/* Floating "scroll to latest" — appears when off the live tail (like Terminal). */}
      {showDown && (
        <button
          title="Scroll to latest"
          onClick={() => void scrollToLatest()}
          style={{ position: 'absolute', right: 16, bottom: 116, width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', color: '#06140B', border: 'none', boxShadow: '0 8px 22px -6px rgba(0,0,0,.7)', cursor: 'pointer', zIndex: 5 }}
        >
          <CaretDoubleDown size={19} weight="bold" />
        </button>
      )}

      {/* Floating, draggable "jump to previous user message" arrow. Press to enlarge
          + wiggle (it's draggable); tap to jump; drag to reposition. */}
      <button
        ref={arrowRef}
        onPointerDown={onArrowDown}
        onPointerMove={onArrowMove}
        onPointerUp={onArrowUp}
        title="Jump to previous message (drag to move)"
        style={{
          position: 'absolute', ...(arrowPos ? { left: arrowPos.left, top: arrowPos.top } : { right: 16, bottom: 170 }),
          width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--color-elevated)', border: '1px solid #2c2c32', color: 'var(--color-text-secondary)',
          boxShadow: grabbed ? '0 14px 30px -6px rgba(0,0,0,.75)' : '0 6px 18px -6px rgba(0,0,0,.6)',
          cursor: 'grab', touchAction: 'none', zIndex: 6,
          transform: grabbed ? 'scale(1.2)' : 'scale(1)',
          transition: 'transform .12s ease, box-shadow .12s ease',
          animation: grabbed ? 'dispatchWiggle .4s ease-in-out infinite' : 'none',
        }}
      >
        <ArrowUp size={18} weight="bold" />
      </button>

      {/* Upload feedback toast */}
      {note && <div style={{ position: 'absolute', left: 14, bottom: 70, zIndex: 6, background: 'rgba(10,10,12,.85)', color: 'var(--color-accent)', fontSize: 12, fontWeight: 500, padding: '5px 11px', borderRadius: 9, pointerEvents: 'none' }}>{note}</div>}

      {/* Compose box (file · text · send). View never writes to View — this submits
          to the live PTY and flips to Terminal so you watch the agent run it. */}
      <form
        onSubmit={(e) => { e.preventDefault(); sendToTerminal(); }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, padding: '8px 10px', paddingBottom: 'calc(8px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)' }}
      >
        <label title="Attach image" style={{ height: 38, width: 38, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 11, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
          <Paperclip size={18} />
          <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { void attachFiles(e.target.files); e.currentTarget.value = ''; }} />
        </label>
        <input
          value={composeText}
          onChange={(e) => setComposeText(e.target.value)}
          placeholder={structured ? 'Message…' : 'Message — sends in Terminal…'}
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          enterKeyHint="send"
          style={{ flex: 1, minWidth: 0, height: 38, padding: '0 13px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 11, color: 'var(--color-text-primary)', fontSize: 16, outline: 'none' }}
        />
        <button type="submit" title="Send in Terminal" style={{ height: 38, width: 38, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', color: '#06140B', border: 'none', borderRadius: 11, cursor: 'pointer' }}>
          <PaperPlaneTilt size={18} weight="fill" />
        </button>
      </form>

    </div>
  );
}

// "★ Insight ───…" / content / "───…" callout blocks Claude emits in explanatory
// mode. The opener and closer lines are wrapped in backticks (inline code) in the
// transcript — `★ Insight ───` … `───`. Both delimiters must be a WHOLE line
// (^…$ with the m flag): opener = "★ Insight" + dashes only, closer = dashes only.
// This prevents an inline prose mention of "★ Insight" from opening a bogus block
// and swallowing earlier content up to the next dashed line.
const INSIGHT_RE = /^[ \t]*`?★[ \t]*Insight[ \t]*─+`?[ \t]*\n([\s\S]*?)\n[ \t]*`?─{5,}`?[ \t]*(?=\n|$)/gm;

function renderAssistant(text: string): React.ReactNode {
  if (!text.includes('Insight') || !text.includes('─')) {
    return <div className="md-view" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  }
  const parts: React.ReactNode[] = [];
  let last = 0; let i = 0; let m: RegExpExecArray | null;
  INSIGHT_RE.lastIndex = 0;
  while ((m = INSIGHT_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(<div key={`t${i}`} className="md-view" dangerouslySetInnerHTML={{ __html: renderMarkdown(text.slice(last, m.index)) }} />);
    parts.push(<InsightBox key={`i${i}`} body={m[1]} />);
    last = m.index + m[0].length; i++;
  }
  if (!parts.length) return <div className="md-view" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  if (last < text.length) parts.push(<div key="tend" className="md-view" dangerouslySetInnerHTML={{ __html: renderMarkdown(text.slice(last)) }} />);
  return <>{parts}</>;
}

function InsightBox({ body }: { body: string }) {
  return (
    <div style={{ margin: '4px 0', borderRadius: 10, border: '1px solid color-mix(in srgb, var(--color-accent) 32%, transparent)', background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)', padding: '9px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-accent)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
        <Sparkle size={13} weight="fill" /> Insight
      </div>
      <div className="md-view" style={{ fontSize: 13 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(body.trim()) }} />
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
    return <div style={{ fontSize: 13.5 }}>{renderAssistant(item.text ?? '')}</div>;
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
