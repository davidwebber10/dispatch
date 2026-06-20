import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CaretDoubleDown } from '@phosphor-icons/react';
import '@xterm/xterm/css/xterm.css';
import { openTerminalSocket } from '../../api/terminal-socket';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSettings } from '../../stores/settings';

const SOFT_KEYS: { label: string; seq: string }[] = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\t' },
  { label: '⌃C', seq: '\x03' },
  { label: '⏎', seq: '\r' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
];

export function TerminalTab({ terminalId, socketFactory = openTerminalSocket }: { terminalId: string; socketFactory?: typeof openTerminalSocket }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollOverlayRef = useRef<HTMLDivElement>(null);
  const sockRef = useRef<ReturnType<typeof openTerminalSocket> | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [meta, setMeta] = useState<Terminal | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [drop, setDrop] = useState(false);
  const [note, setNote] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [mobileInput, setMobileInput] = useState('');
  const isMobile = useIsMobile();
  const termFontSize = useSettings((s) => s.fontSize);
  const termScrollback = useSettings((s) => s.scrollback);
  const forceFitRef = useRef<() => void>(() => {});
  const scrollToEndRef = useRef<() => void>(() => {});
  const rowMeasureRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    const s0 = useSettings.getState();
    const term = new XTerm({ fontFamily: 'JetBrains Mono, monospace', fontSize: s0.fontSize, theme: { background: '#1E1E1E' }, scrollback: s0.scrollback, convertEol: true, cursorBlink: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    if (hostRef.current) { try { term.open(hostRef.current); } catch { /* jsdom */ } }

    const sock = socketFactory({ terminalId, onData: (chunk) => term.write(chunk) });
    sockRef.current = sock;
    term.onData((d) => sock.send(d));

    let lastW = -1, lastH = -1, lastCols = -1, lastRows = -1, pending = false;
    const scheduleFit = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const el = hostRef.current;
        if (disposed || !el) return;
        const w = el.clientWidth, h = el.clientHeight;
        if (w === lastW && h === lastH) return;
        lastW = w; lastH = h;
        if (w === 0 || h === 0) return;
        try { fit.fit(); } catch { return; }
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols; lastRows = term.rows;
          sockRef.current?.resize(term.cols, term.rows);
        }
        rowMeasureRef.current();
      });
    };

    // Force a refit even when the container size is unchanged (e.g. font-size change).
    forceFitRef.current = () => {
      const el = hostRef.current;
      if (disposed || !el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try { fit.fit(); } catch { return; }
      lastW = el.clientWidth; lastH = el.clientHeight;
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols; lastRows = term.rows;
        sockRef.current?.resize(term.cols, term.rows);
      }
      rowMeasureRef.current();
    };

    requestAnimationFrame(() => { if (!disposed) { scheduleFit(); try { term.focus(); } catch { /* jsdom */ } } });

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && hostRef.current) {
      ro = new ResizeObserver(() => scheduleFit());
      ro.observe(hostRef.current);
    }
    window.addEventListener('resize', scheduleFit);

    // --- Sub-pixel smooth touch scrolling (mobile) ---
    // xterm's DOM renderer only repaints in whole rows, so every scroll path it
    // offers (its own touch handler, scrollLines, viewport.scrollTop) makes the
    // text stick then jump ~1 row (≈17px). We own the gesture and split scrolling
    // into: term.scrollLines for whole rows + a translate3d on .xterm-screen for
    // the sub-row remainder, so the text tracks the finger continuously. Two
    // things that previously made this "really bad": (1) reading row height with
    // getBoundingClientRect every frame (a layout reflow per frame) — now cached;
    // (2) applying the transform synchronously after scrollLines, a frame before
    // xterm repaints the new row — torn frame / flicker. We now apply the
    // remainder transform inside term.onRender so it is locked to the repaint.
    const host = hostRef.current;
    const viewportEl = () => host?.querySelector('.xterm-viewport') as HTMLElement | null;
    const screenEl = () => host?.querySelector('.xterm-screen') as HTMLElement | null;
    const xtermEl = host?.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) { xtermEl.style.overflow = 'hidden'; xtermEl.style.touchAction = 'none'; }
    if (host) host.style.touchAction = 'none';
    // On touch devices, forbid text selection across the whole terminal subtree.
    // Otherwise a drag that starts over text begins an iOS selection instead of
    // scrolling (xterm's accessibility-tree overlay is user-select:text), which
    // is why scrolling only felt right when the finger was over empty space.
    if (isMobile && host) host.classList.add('dispatch-noselect');
    { const s = screenEl(); if (s) { s.style.background = '#1E1E1E'; s.style.willChange = 'transform'; } }

    let rowHeight = Math.ceil((term.options.fontSize ?? 13) * 1.2);
    rowMeasureRef.current = () => { const r = host?.querySelector('.xterm-rows') as HTMLElement | null; if (r && r.children.length) rowHeight = r.getBoundingClientRect().height / r.children.length; };

    let subPx = 0; // sub-row remainder, applied as a screen translate
    const applyTransform = () => { const s = screenEl(); if (s) s.style.transform = subPx ? `translate3d(0,${-subPx}px,0)` : ''; };
    const offRender = term.onRender(() => applyTransform()); // keep the remainder locked to each repaint

    const viewportAtBottom = () => { const vp = viewportEl(); return !vp || (vp.scrollHeight - vp.clientHeight - vp.scrollTop < 4 && subPx === 0); };
    const updateAtBottom = () => setAtBottom(viewportAtBottom());

    let inertiaId = 0;
    let lastY = 0, lastT = 0, vel = 0, startY = 0, moved = false;
    const stopInertia = () => { if (inertiaId) { cancelAnimationFrame(inertiaId); inertiaId = 0; } };
    const scrollByPx = (px: number) => {
      const h = rowHeight || 17;
      const newSub = subPx + px;
      const lines = Math.floor(newSub / h);
      subPx = newSub - lines * h; // remainder in [0, h)
      if (lines !== 0) {
        const before = term.buffer.active.viewportY;
        term.scrollLines(lines);
        const b = term.buffer.active;
        if (b.viewportY >= b.baseY && px > 0) subPx = 0;   // flush at the latest line
        else if (b.viewportY <= 0 && px < 0) subPx = 0;    // flush at the top
        if (b.viewportY === before) applyTransform();      // clamped: no repaint coming, apply now
        // otherwise onRender applies the new remainder in lockstep with the repaint
      } else {
        applyTransform(); // pure sub-row move, content unchanged — safe to apply now
      }
      updateAtBottom();
    };
    const onTouchStart = (e: TouchEvent) => { stopInertia(); lastY = e.touches[0].clientY; startY = lastY; moved = false; lastT = performance.now(); vel = 0; };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY, now = performance.now();
      const dy = lastY - y, dt = now - lastT;
      lastY = y; lastT = now;
      if (Math.abs(y - startY) > 6) moved = true;
      if (dt > 0) vel = dy / dt;
      scrollByPx(dy);
      e.preventDefault();
    };
    const onTouchEnd = () => {
      if (!moved) return; // terminal is non-interactive on mobile — a tap does nothing (type via the input bar)
      let v = Math.max(-12, Math.min(12, vel));
      if (Math.abs(v) < 0.03) return;
      let prev = performance.now();
      const step = () => {
        const now = performance.now(); const dt = Math.max(1, now - prev); prev = now;
        v *= Math.pow(0.95, dt / 16);
        if (Math.abs(v) < 0.02) { inertiaId = 0; return; }
        scrollByPx(v * dt);
        inertiaId = requestAnimationFrame(step);
      };
      inertiaId = requestAnimationFrame(step);
    };
    // Attach to a STABLE transparent overlay, never to the xterm content: the DOM
    // renderer destroys the <span> under the finger on every repaint, which makes
    // iOS fire touchcancel and abort the gesture (scrolling died "after one line"
    // whenever the finger was over text). The overlay never changes, so the touch
    // sequence survives the repaints.
    const touchSurface = scrollOverlayRef.current;
    if (touchSurface) {
      touchSurface.addEventListener('touchstart', onTouchStart, { passive: true });
      touchSurface.addEventListener('touchmove', onTouchMove, { passive: false });
      touchSurface.addEventListener('touchend', onTouchEnd, { passive: true });
      touchSurface.addEventListener('touchcancel', onTouchEnd, { passive: true });
    }

    const vp0 = viewportEl();
    vp0?.addEventListener('scroll', updateAtBottom, { passive: true });
    const offScroll = term.onScroll(() => updateAtBottom());
    updateAtBottom();
    scrollToEndRef.current = () => { stopInertia(); subPx = 0; applyTransform(); term.scrollToBottom(); updateAtBottom(); };

    void api.getTerminal(terminalId).then((m) => {
      if (disposed) return;
      setMeta(m);
      api.getGitInfo(m.sessionId).then((g) => { if (!disposed) setBranch(g.branch); }).catch(() => { /* best effort */ });
    });

    return () => {
      disposed = true;
      stopInertia();
      if (touchSurface) {
        touchSurface.removeEventListener('touchstart', onTouchStart);
        touchSurface.removeEventListener('touchmove', onTouchMove);
        touchSurface.removeEventListener('touchend', onTouchEnd);
        touchSurface.removeEventListener('touchcancel', onTouchEnd);
      }
      vp0?.removeEventListener('scroll', updateAtBottom);
      offScroll.dispose();
      offRender.dispose();
      ro?.disconnect();
      window.removeEventListener('resize', scheduleFit);
      sock.close();
      term.dispose();
      sockRef.current = null;
      termRef.current = null;
    };
  }, [terminalId, socketFactory]);

  // Apply font-size / scrollback changes live to the running terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.fontSize = termFontSize;
      term.options.scrollback = termScrollback;
      forceFitRef.current();
    } catch { /* terminal not fully initialised (e.g. jsdom) */ }
  }, [termFontSize, termScrollback]);

  async function uploadImage(file: File) {
    if (!meta) return;
    setNote(`Uploading ${file.name}…`);
    try {
      const res = await api.uploadInbox(meta.sessionId, file);
      await api.sendFileReference(terminalId, res.path, 'agent-context');
      setNote(`Sent ${file.name} ↗`);
    } catch { setNote('Upload failed'); }
    setTimeout(() => setNote(''), 2500);
  }
  function onFiles(files: FileList | null) {
    if (files) for (const f of Array.from(files)) void uploadImage(f);
  }

  // Mobile input: the terminal is read-only to touch (you can only scroll it),
  // so typing happens here and is sent to the PTY as a submitted line.
  function sendMobileInput() {
    const v = mobileInput;
    if (!v) return;
    sockRef.current?.send(v + '\r');
    setMobileInput('');
  }

  return (
    <div
      onMouseDown={() => { if (!isMobile) { try { termRef.current?.focus(); } catch { /* */ } } }}
      onDragOver={(e) => { e.preventDefault(); setDrop(true); }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => { e.preventDefault(); setDrop(false); onFiles(e.dataTransfer.files); }}
      onPaste={(e) => { const f = Array.from(e.clipboardData?.files ?? []); if (f.length) { e.preventDefault(); f.forEach((x) => void uploadImage(x)); } }}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--color-terminal)', position: 'relative' }}
    >
      {/* The xterm host is absolutely positioned so the terminal's own size never
          drives the flex layout width (which previously blew the column out). */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0, padding: 15 }} />
        {/* Stable transparent touch surface (mobile): the gesture lands here, never
            on the xterm spans that get destroyed on every repaint. Sits above the
            terminal but below the jump-to-latest button. */}
        {isMobile && <div ref={scrollOverlayRef} style={{ position: 'absolute', inset: 0, zIndex: 3, touchAction: 'none' }} />}
        {!atBottom && (
          <button
            title="Scroll to latest"
            onClick={() => scrollToEndRef.current()}
            style={{ position: 'absolute', right: 16, bottom: 16, width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', color: '#06140B', border: 'none', boxShadow: '0 8px 22px -6px rgba(0,0,0,.7)', cursor: 'pointer', zIndex: 6 }}
          >
            <CaretDoubleDown size={19} weight="bold" />
          </button>
        )}
        {drop && (
          <div style={{ position: 'absolute', inset: 8, border: '2px dashed var(--color-accent)', borderRadius: 10, background: 'rgba(62,207,106,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: 'var(--color-accent)', fontSize: 14, fontWeight: 600 }}>Drop image → send to the agent</div>
        )}
      </div>
      {isMobile && (
        <>
          <div style={{ display: 'flex', gap: 6, padding: '6px 8px', background: 'var(--color-pane)', borderTop: '1px solid var(--color-border)', overflowX: 'auto', flexShrink: 0 }}>
            {SOFT_KEYS.map((k) => (
              <button key={k.label}
                onPointerDown={(e) => { e.preventDefault(); sockRef.current?.send(k.seq); }}
                style={{ minWidth: 42, height: 34, flexShrink: 0, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 7, color: 'var(--color-text-primary)', font: '500 13px var(--font-mono)', cursor: 'pointer' }}>
                {k.label}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); sendMobileInput(); }}
            style={{ display: 'flex', gap: 8, padding: '8px', background: 'var(--color-pane)', borderTop: '1px solid var(--color-border)', flexShrink: 0, alignItems: 'center', paddingBottom: 'calc(8px + env(safe-area-inset-bottom))' }}
          >
            <input
              value={mobileInput}
              onChange={(e) => setMobileInput(e.target.value)}
              placeholder="Type a message or command…"
              autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
              enterKeyHint="send"
              /* 16px font avoids iOS auto-zoom on focus */
              style={{ flex: 1, minWidth: 0, height: 40, padding: '0 13px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 10, color: 'var(--color-text-primary)', fontSize: 16 }}
            />
            <button type="submit" style={{ height: 40, padding: '0 18px', flexShrink: 0, background: 'var(--color-accent)', color: '#06140B', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: 15, cursor: 'pointer' }}>Send</button>
          </form>
        </>
      )}
      <div style={{ height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', background: 'var(--color-pane)', borderTop: '1px solid var(--color-border)', font: '400 11px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta?.workingDir ?? ''}</span>
        {branch && <span style={{ flexShrink: 0 }}>⎇ {branch}</span>}
        {note && <span style={{ color: 'var(--color-accent)', flexShrink: 0 }}>{note}</span>}
        <label title="Attach image" style={{ marginLeft: 'auto', cursor: 'pointer', flexShrink: 0 }}>
          📎
          <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => onFiles(e.target.files)} />
        </label>
        <span style={{ flexShrink: 0 }}>{meta?.status === 'working' ? `Working · pid ${meta?.pid ?? '—'}` : `pid ${meta?.pid ?? '—'}`}</span>
      </div>
    </div>
  );
}
