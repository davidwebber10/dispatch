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
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
];

export function TerminalTab({ terminalId, socketFactory = openTerminalSocket }: { terminalId: string; socketFactory?: typeof openTerminalSocket }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sockRef = useRef<ReturnType<typeof openTerminalSocket> | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [meta, setMeta] = useState<Terminal | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [drop, setDrop] = useState(false);
  const [note, setNote] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const isMobile = useIsMobile();
  const termFontSize = useSettings((s) => s.fontSize);
  const termScrollback = useSettings((s) => s.scrollback);
  const forceFitRef = useRef<() => void>(() => {});
  const scrollToEndRef = useRef<() => void>(() => {});

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
    };

    requestAnimationFrame(() => { if (!disposed) { scheduleFit(); try { term.focus(); } catch { /* jsdom */ } } });

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && hostRef.current) {
      ro = new ResizeObserver(() => scheduleFit());
      ro.observe(hostRef.current);
    }
    window.addEventListener('resize', scheduleFit);

    // --- Natural momentum touch scrolling (mobile) ---
    // xterm's native touch scroll is 1:1 and inertia-less; we take over the
    // gesture and drive the real .xterm-viewport scrollTop in PIXELS (not
    // term.scrollLines, which quantises to whole rows and feels steppy). This
    // matches the pixel-smoothness of dragging the scrollbar on desktop.
    const host = hostRef.current;
    const viewportEl = () => host?.querySelector('.xterm-viewport') as HTMLElement | null;
    let inertiaId = 0;
    let lastY = 0, lastT = 0, vel = 0;
    const scrollByPx = (px: number) => { const vp = viewportEl(); if (vp) vp.scrollTop += px; };
    const updateAtBottom = () => { const vp = viewportEl(); if (vp) setAtBottom(vp.scrollHeight - vp.clientHeight - vp.scrollTop < 4); };
    const stopInertia = () => { if (inertiaId) { cancelAnimationFrame(inertiaId); inertiaId = 0; } };
    const onTouchStart = (e: TouchEvent) => {
      stopInertia();
      lastY = e.touches[0].clientY; lastT = performance.now(); vel = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const now = performance.now();
      const dy = lastY - y, dt = now - lastT;
      lastY = y; lastT = now;
      if (dt > 0) vel = dy / dt;
      scrollByPx(dy);
      e.preventDefault();
      e.stopPropagation();
    };
    const onTouchEnd = () => {
      let v = Math.max(-10, Math.min(10, vel));
      if (Math.abs(v) < 0.02) return;
      let prev = performance.now();
      const step = () => {
        const now = performance.now();
        const dt = Math.max(1, now - prev); prev = now;
        v *= Math.pow(0.95, dt / 16);
        if (Math.abs(v) < 0.015) { inertiaId = 0; return; }
        scrollByPx(v * dt);
        inertiaId = requestAnimationFrame(step);
      };
      inertiaId = requestAnimationFrame(step);
    };
    if (host) {
      host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
      host.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    }

    // Track whether we're pinned to the latest output. The native 'scroll'
    // event fires for both user touch/wheel scrolling and xterm's own
    // scrollTop sync on new output, so it covers every case.
    const vp0 = viewportEl();
    vp0?.addEventListener('scroll', updateAtBottom, { passive: true });
    updateAtBottom();
    scrollToEndRef.current = () => { stopInertia(); term.scrollToBottom(); updateAtBottom(); };

    void api.getTerminal(terminalId).then((m) => {
      if (disposed) return;
      setMeta(m);
      api.getGitInfo(m.sessionId).then((g) => { if (!disposed) setBranch(g.branch); }).catch(() => { /* best effort */ });
    });

    return () => {
      disposed = true;
      stopInertia();
      if (host) {
        host.removeEventListener('touchstart', onTouchStart, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchmove', onTouchMove, { capture: true } as EventListenerOptions);
        host.removeEventListener('touchend', onTouchEnd, { capture: true } as EventListenerOptions);
      }
      vp0?.removeEventListener('scroll', updateAtBottom);
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

  return (
    <div
      onMouseDown={() => { try { termRef.current?.focus(); } catch { /* */ } }}
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
        <div style={{ display: 'flex', gap: 6, padding: '6px 8px', background: 'var(--color-pane)', borderTop: '1px solid var(--color-border)', overflowX: 'auto', flexShrink: 0 }}>
          {SOFT_KEYS.map((k) => (
            <button key={k.label}
              onPointerDown={(e) => { e.preventDefault(); sockRef.current?.send(k.seq); try { termRef.current?.focus(); } catch { /* */ } }}
              style={{ minWidth: 42, height: 34, flexShrink: 0, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 7, color: 'var(--color-text-primary)', font: '500 13px var(--font-mono)', cursor: 'pointer' }}>
              {k.label}
            </button>
          ))}
        </div>
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
