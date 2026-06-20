import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CaretDoubleDown, Paperclip, CaretUp, CaretDown, CaretLeft, CaretRight, ArrowElbowDownLeft, type Icon } from '@phosphor-icons/react';
import { Spinner } from '../common/Spinner';
import '@xterm/xterm/css/xterm.css';
import { openTerminalSocket } from '../../api/terminal-socket';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSettings } from '../../stores/settings';

type SoftKey = { label: string; seq: string; title?: string; Icon?: Icon };
const ENTER: SoftKey = { label: 'Enter', seq: '\r', title: 'Enter', Icon: ArrowElbowDownLeft };
const UP_DOWN: SoftKey[] = [
  { label: 'Up', seq: '\x1b[A', title: 'Up', Icon: CaretUp },
  { label: 'Down', seq: '\x1b[B', title: 'Down', Icon: CaretDown },
];
// Slash commands send their text; no-arg ones run on tap (\r), arg ones leave a
// trailing space for you to fill in.
const CLAUDE_KEYS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' }, ENTER, ...UP_DOWN,
  { label: '⌃O', seq: '\x0f', title: 'Ctrl-O' },
  { label: '⌃E', seq: '\x05', title: 'Ctrl-E' },
  { label: '/mcp', seq: '/mcp\r', title: '/mcp' },
  { label: '/btw', seq: '/btw ', title: '/btw' },
  { label: '/effort', seq: '/effort ', title: '/effort' },
  { label: '/resume', seq: '/resume\r', title: '/resume' },
];
const CODEX_KEYS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' }, ENTER, ...UP_DOWN,
  { label: '/model', seq: '/model\r', title: '/model' },
  { label: '/approvals', seq: '/approvals\r', title: '/approvals' },
  { label: '/mcp', seq: '/mcp\r', title: '/mcp' },
  { label: '/status', seq: '/status\r', title: '/status' },
];
const SHELL_KEYS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' },
  { label: 'tab', seq: '\t', title: 'Tab' },
  { label: '⌃C', seq: '\x03', title: 'Ctrl-C' }, ENTER, ...UP_DOWN,
  { label: 'Left', seq: '\x1b[D', title: 'Left', Icon: CaretLeft },
  { label: 'Right', seq: '\x1b[C', title: 'Right', Icon: CaretRight },
];
function softKeysFor(type?: string): SoftKey[] {
  return type === 'codex' ? CODEX_KEYS : type === 'shell' ? SHELL_KEYS : CLAUDE_KEYS;
}

export function TerminalTab({ terminalId, socketFactory = openTerminalSocket }: { terminalId: string; socketFactory?: typeof openTerminalSocket }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollOverlayRef = useRef<HTMLDivElement>(null);
  const sockRef = useRef<ReturnType<typeof openTerminalSocket> | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [meta, setMeta] = useState<Terminal | null>(null);
  const [drop, setDrop] = useState(false);
  const [note, setNote] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [loading, setLoading] = useState(true);
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

    let gotData = false;
    const sock = socketFactory({ terminalId, onData: (chunk) => { term.write(chunk); if (!gotData) { gotData = true; setLoading(false); } } });
    sockRef.current = sock;
    // Hide the loading indicator once content arrives (or after a short grace
    // period so a genuinely-quiet terminal doesn't spin forever).
    const loadTimer = setTimeout(() => setLoading(false), 6000);
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
    // .xterm-viewport is overflow-y:scroll, which makes its overflow-x compute to
    // auto — on iOS that yields a phantom horizontal scroll/rubber-band. Pin it.
    { const vp = viewportEl(); if (vp) { vp.style.overflowX = 'hidden'; vp.style.touchAction = 'none'; } }
    // On touch devices, forbid text selection across the whole terminal subtree.
    // Otherwise a drag that starts over text begins an iOS selection instead of
    // scrolling (xterm's accessibility-tree overlay is user-select:text), which
    // is why scrolling only felt right when the finger was over empty space.
    if (isMobile && host) host.classList.add('dispatch-noselect');
    { const s = screenEl(); if (s) { s.style.background = '#1E1E1E'; s.style.willChange = 'transform'; } }

    let rowHeight = Math.ceil((term.options.fontSize ?? 13) * 1.2);
    rowMeasureRef.current = () => { const r = host?.querySelector('.xterm-rows') as HTMLElement | null; if (r && r.children.length) rowHeight = r.getBoundingClientRect().height / r.children.length; };

    let subPx = 0;       // sub-row remainder, applied as a screen translate
    let overscroll = 0;  // signed px pulled past an end (>0 past bottom) — the rubber-band
    const applyTransform = () => { const s = screenEl(); if (!s) return; const ty = -subPx - overscroll; s.style.transform = ty ? `translate3d(0,${ty}px,0)` : ''; };
    const offRender = term.onRender(() => applyTransform()); // keep the offset locked to each repaint

    const viewportAtBottom = () => { const vp = viewportEl(); return !vp || (vp.scrollHeight - vp.clientHeight - vp.scrollTop < 4 && subPx === 0 && overscroll === 0); };
    const updateAtBottom = () => setAtBottom(viewportAtBottom());

    let inertiaId = 0, springId = 0;
    let lastY = 0, lastT = 0, vel = 0, startY = 0, moved = false;
    const stopInertia = () => { if (inertiaId) { cancelAnimationFrame(inertiaId); inertiaId = 0; } };
    const stopSpring = () => { if (springId) { cancelAnimationFrame(springId); springId = 0; } };
    const springBack = () => {
      stopSpring();
      const step = () => {
        overscroll *= 0.8;
        if (Math.abs(overscroll) < 0.5) { overscroll = 0; springId = 0; applyTransform(); updateAtBottom(); return; }
        applyTransform();
        springId = requestAnimationFrame(step);
      };
      springId = requestAnimationFrame(step);
    };
    const scrollByPx = (px: number) => {
      const h = rowHeight || 17;
      // Already rubber-banded: deeper pull resists (×0.45), pulling back releases
      // it 1:1; snap to 0 when it crosses neutral. Never touches content here.
      if (overscroll !== 0) {
        const prev = overscroll;
        overscroll += ((overscroll > 0) === (px > 0)) ? px * 0.45 : px;
        if ((prev > 0) !== (overscroll > 0)) overscroll = 0;
        overscroll = Math.max(-150, Math.min(150, overscroll));
        applyTransform(); updateAtBottom(); return;
      }
      const b0 = term.buffer.active;
      // Flush against an end and still pushing further → start a rubber-band
      // instead of jittering the screen against the wall.
      if ((b0.viewportY >= b0.baseY && subPx === 0 && px > 0) || (b0.viewportY <= 0 && subPx === 0 && px < 0)) {
        overscroll = Math.max(-150, Math.min(150, px * 0.45));
        applyTransform(); updateAtBottom(); return;
      }
      // Normal content scroll.
      const newSub = subPx + px;
      const lines = Math.floor(newSub / h);
      let rem = newSub - lines * h; // remainder in [0, h)
      const before = b0.viewportY;
      if (lines !== 0) term.scrollLines(lines);
      const b = term.buffer.active;
      // Never translate into empty space past the ends — this is the jitter fix
      // (the clamp now runs on EVERY move, not only when a whole row commits).
      if (b.viewportY >= b.baseY) rem = 0;                              // flush at the last line
      else if (b.viewportY <= 0 && b.viewportY === before && lines < 0) rem = 0; // flush at the top
      subPx = rem;
      if (b.viewportY === before) applyTransform(); // no repaint coming → apply now; else onRender does
      updateAtBottom();
    };
    const onTouchStart = (e: TouchEvent) => { stopInertia(); stopSpring(); lastY = e.touches[0].clientY; startY = lastY; moved = false; lastT = performance.now(); vel = 0; };
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
      if (overscroll !== 0) { springBack(); return; } // released mid rubber-band → bounce home
      if (!moved) return; // terminal is non-interactive on mobile — a tap does nothing (type via the input bar)
      let v = Math.max(-12, Math.min(12, vel));
      if (Math.abs(v) < 0.03) return;
      let prev = performance.now();
      const step = () => {
        const now = performance.now(); const dt = Math.max(1, now - prev); prev = now;
        v *= Math.pow(0.95, dt / 16);
        if (Math.abs(v) < 0.02) { inertiaId = 0; return; }
        scrollByPx(v * dt);
        if (overscroll !== 0) { inertiaId = 0; springBack(); return; } // fling hit an end → bounce
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
    scrollToEndRef.current = () => { stopInertia(); stopSpring(); subPx = 0; overscroll = 0; applyTransform(); term.scrollToBottom(); updateAtBottom(); };

    void api.getTerminal(terminalId).then((m) => {
      if (disposed) return;
      setMeta(m);
    });

    return () => {
      disposed = true;
      clearTimeout(loadTimer);
      stopInertia();
      stopSpring();
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
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: isMobile ? 'var(--color-pane)' : 'var(--color-terminal)', position: 'relative' }}
    >
      {/* The xterm host is absolutely positioned so the terminal's own size never
          drives the flex layout width (which previously blew the column out).
          On mobile the terminal is a rounded card with a thin frame (the pane bg
          shows through the 2px margin). */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', ...(isMobile ? { margin: 2, borderRadius: 13, background: 'var(--color-terminal)' } : {}) }}>
        {/* inset (not padding): FitAddon measures the host's width, and padding on
            the host makes it over-count columns so the right edge clips. */}
        <div ref={hostRef} style={{ position: 'absolute', inset: isMobile ? 12 : 15 }} />
        {/* Stable transparent touch surface (mobile): the gesture lands here, never
            on the xterm spans that get destroyed on every repaint. Sits above the
            terminal but below the jump-to-latest button. */}
        {isMobile && <div ref={scrollOverlayRef} style={{ position: 'absolute', inset: 0, zIndex: 3, touchAction: 'none' }} />}
        {loading && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-terminal)', pointerEvents: 'none' }}>
            <Spinner size={26} />
          </div>
        )}
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
        {note && (
          <div style={{ position: 'absolute', left: 14, bottom: 14, zIndex: 6, background: 'rgba(10,10,12,.85)', color: 'var(--color-accent)', fontSize: 12, fontWeight: 500, padding: '5px 11px', borderRadius: 9, pointerEvents: 'none' }}>{note}</div>
        )}
      </div>
      {isMobile && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 8px', background: 'var(--color-pane)', borderTop: '1px solid var(--color-border)', flexShrink: 0 }}>
            {softKeysFor(meta?.type).map((k) => (
              <button key={k.label} title={k.title}
                onPointerDown={(e) => { e.preventDefault(); sockRef.current?.send(k.seq); }}
                style={{ flex: '1 1 auto', minWidth: 40, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 7, color: 'var(--color-text-primary)', font: '500 14px var(--font-mono)', cursor: 'pointer' }}>
                {k.Icon ? <k.Icon size={18} weight="bold" /> : k.label}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); sendMobileInput(); }}
            style={{ display: 'flex', gap: 8, padding: '8px', background: 'var(--color-pane)', borderTop: '1px solid var(--color-border)', flexShrink: 0, alignItems: 'center', paddingBottom: 'calc(8px + env(safe-area-inset-bottom))' }}
          >
            <label title="Attach image" style={{ height: 40, width: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 10, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
              <Paperclip size={20} weight="regular" />
              <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files); e.currentTarget.value = ''; }} />
            </label>
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
    </div>
  );
}
