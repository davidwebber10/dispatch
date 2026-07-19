import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CaretDoubleDown, CaretUp, CaretDown, CaretLeft, CaretRight, ArrowElbowDownLeft, MagnifyingGlass, X, type Icon } from '@phosphor-icons/react';
import { Spinner } from '../common/Spinner';
import '@xterm/xterm/css/xterm.css';
import { openTerminalSocket, INITIAL_REPLAY_MOBILE, MAX_REPLAY, nextReplayStep } from '../../api/terminal-socket';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useDraft } from '../../hooks/useDraft';
import { useSettings } from '../../stores/settings';
import { useDictation } from '../../hooks/useDictation';
import { DictationControl } from '../dictation/DictationControl';
import { InputActionsMenu } from '../dictation/InputActionsMenu';

type SoftKey = { label: string; seq: string; title?: string; Icon?: Icon };
// Slash commands live in a searchable sheet behind the "/" key. Run-commands end
// in \r so they fire on tap; arg-commands leave a trailing space to type into.
type SlashCmd = { cmd: string; seq: string; desc: string };

const ENTER: SoftKey = { label: 'Enter', seq: '\r', title: 'Enter', Icon: ArrowElbowDownLeft };
const UP_DOWN: SoftKey[] = [
  { label: 'Up', seq: '\x1b[A', title: 'Up', Icon: CaretUp },
  { label: 'Down', seq: '\x1b[B', title: 'Down', Icon: CaretDown },
];

const CLAUDE_ACTIONS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' }, ENTER, ...UP_DOWN,
  { label: '⌃O', seq: '\x0f', title: 'Ctrl-O' },
  { label: '⌃E', seq: '\x05', title: 'Ctrl-E' },
];
const CODEX_ACTIONS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' }, ENTER, ...UP_DOWN,
];
const SHELL_ACTIONS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' },
  { label: 'tab', seq: '\t', title: 'Tab' },
  { label: '⌃C', seq: '\x03', title: 'Ctrl-C' }, ENTER, ...UP_DOWN,
  { label: 'Left', seq: '\x1b[D', title: 'Left', Icon: CaretLeft },
  { label: 'Right', seq: '\x1b[C', title: 'Right', Icon: CaretRight },
];

const CLAUDE_SLASH: SlashCmd[] = [
  { cmd: '/resume', seq: '/resume\r', desc: 'Resume a previous conversation' },
  { cmd: '/clear', seq: '/clear\r', desc: 'Clear the conversation' },
  { cmd: '/compact', seq: '/compact\r', desc: 'Summarize & shrink the context' },
  { cmd: '/context', seq: '/context\r', desc: 'Show context-window usage' },
  { cmd: '/cost', seq: '/cost\r', desc: 'Show token cost this session' },
  { cmd: '/model', seq: '/model ', desc: 'Switch the model' },
  { cmd: '/agents', seq: '/agents\r', desc: 'Manage subagents' },
  { cmd: '/mcp', seq: '/mcp\r', desc: 'MCP server status & tools' },
  { cmd: '/memory', seq: '/memory\r', desc: 'Edit CLAUDE.md memory' },
  { cmd: '/init', seq: '/init\r', desc: 'Generate a CLAUDE.md' },
  { cmd: '/review', seq: '/review\r', desc: 'Review a pull request' },
  { cmd: '/config', seq: '/config\r', desc: 'Open settings' },
  { cmd: '/status', seq: '/status\r', desc: 'Account & session status' },
  { cmd: '/export', seq: '/export\r', desc: 'Export the conversation' },
  { cmd: '/vim', seq: '/vim\r', desc: 'Toggle vim editing mode' },
  { cmd: '/effort', seq: '/effort ', desc: 'Set reasoning effort' },
  { cmd: '/btw', seq: '/btw ', desc: 'Slip in a note mid-task' },
  { cmd: '/help', seq: '/help\r', desc: 'List all commands' },
];
// Codex CLI slash commands (developers.openai.com/codex/cli/slash-commands).
const CODEX_SLASH: SlashCmd[] = [
  { cmd: '/model', seq: '/model\r', desc: 'Model & reasoning effort' },
  { cmd: '/approvals', seq: '/approvals\r', desc: 'Approval mode' },
  { cmd: '/review', seq: '/review\r', desc: 'Review your changes' },
  { cmd: '/new', seq: '/new\r', desc: 'Start a new conversation' },
  { cmd: '/init', seq: '/init\r', desc: 'Create an AGENTS.md' },
  { cmd: '/compact', seq: '/compact\r', desc: 'Summarize & shrink the context' },
  { cmd: '/diff', seq: '/diff\r', desc: 'Show the git diff' },
  { cmd: '/mention', seq: '/mention ', desc: 'Mention a file' },
  { cmd: '/status', seq: '/status\r', desc: 'Session status' },
  { cmd: '/mcp', seq: '/mcp\r', desc: 'MCP tools' },
  { cmd: '/resume', seq: '/resume\r', desc: 'Resume a conversation' },
  { cmd: '/quit', seq: '/quit\r', desc: 'Quit Codex' },
];
function keysFor(type?: string): { actions: SoftKey[]; slash: SlashCmd[] } {
  if (type === 'codex') return { actions: CODEX_ACTIONS, slash: CODEX_SLASH };
  if (type === 'shell') return { actions: SHELL_ACTIONS, slash: [] };
  return { actions: CLAUDE_ACTIONS, slash: CLAUDE_SLASH };
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
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [mobileInput, setMobileInput, clearMobileInput] = useDraft(terminalId);
  const termFileInputRef = useRef<HTMLInputElement>(null);
  const sttConfigured = useSettings((s) => !!s.sttProvider && !!s.sttModel && !!s.sttSecretName);
  const dictation = useDictation((text) => {
    setMobileInput((mobileInput ? mobileInput + ' ' : '') + text);
  });
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
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

    // --- Progressive scrollback (mobile) ---
    // Desktop always requests MAX_REPLAY explicitly — same size, same call shape
    // as before this feature existed, so its replay is never trimmed and none of
    // the rebuild machinery below ever engages there.
    const initialReplay = isMobile ? INITIAL_REPLAY_MOBILE : MAX_REPLAY;
    let currentReplay = initialReplay;
    let hasOlder = false;   // the ring holds more than we've currently loaded
    let rebuilding = false; // guards re-entry: one rebuild at a time
    let pendingLive: string[] = []; // live frames buffered while a rebuild is in flight
    const openSockets = new Set<ReturnType<typeof socketFactory>>();
    const resyncSize = () => { if (term.cols && term.rows) sockRef.current?.resize(term.cols, term.rows); };

    let gotData = false;
    // The "just show it" path: used for every socket's data whenever that data is
    // NOT part of an in-flight rebuild's buffered catch-up — i.e. the original
    // connection's normal traffic, and any survivor-of-a-rebuild socket once it
    // has become primary again.
    const attachLive = (chunk: string) => {
      term.write(chunk);
      if (!gotData) {
        gotData = true;
        setLoading(false);
        // The very first frame is the initial replay. Ask the server whether the
        // ring actually holds more than we requested — if so, a scroll-to-top can
        // later offer to rebuild for it. Deliberately best-effort: a failure here
        // just means scrolling up won't offer more, not a broken attach.
        void api.getScrollbackSize(terminalId).then((total) => {
          if (disposed) return;
          hasOlder = total > currentReplay;
        }).catch(() => { /* best-effort */ });
      }
    };

    function maybeStartRebuild() {
      if (disposed || rebuilding || !hasOlder) return;
      if (currentReplay >= MAX_REPLAY) return;
      if (term.buffer.active.viewportY !== 0) return;
      startRebuild();
    }

    // Rebuild ordering (load-bearing — see the design doc): open the NEW socket
    // first; buffer any live frames arriving on EITHER socket while the rebuild
    // is in flight; when the new socket's replay frame lands, capture the old
    // length/viewportY BEFORE reset, reset, write the replay, then write the
    // buffered live frames (in arrival order) AFTER it; restore the scroll
    // anchor from the POST-write length (measured in the write callback — xterm's
    // write() is async, so reading buffer.active.length synchronously after
    // calling it would still see the pre-write value); close the OLD socket last.
    function startRebuild() {
      rebuilding = true;
      setLoadingOlder(true);
      pendingLive = [];
      const nextSize = nextReplayStep(currentReplay);
      const oldSock = sockRef.current!;
      let gotReplay = false;
      let oldLength = 0;
      let oldViewportY = 0;

      const drainPending = () => {
        if (disposed) return;
        if (pendingLive.length === 0) { finishRebuild(); return; }
        const chunk = pendingLive.shift()!;
        term.write(chunk, drainPending);
      };

      const finishRebuild = () => {
        if (disposed) return;
        const newLength = term.buffer.active.length;
        term.scrollToLine(Math.max(0, oldViewportY + (newLength - oldLength)));
        sockRef.current = newSock;
        openSockets.delete(oldSock);
        oldSock.close();
        currentReplay = nextSize;
        rebuilding = false;
        setLoadingOlder(false);
        void api.getScrollbackSize(terminalId).then((total) => {
          if (disposed) return;
          hasOlder = currentReplay < MAX_REPLAY && total > currentReplay;
        }).catch(() => { hasOlder = false; });
      };

      const newSock = socketFactory({
        terminalId,
        replayBytes: nextSize,
        onData: (chunk) => {
          if (disposed) return;
          if (!gotReplay) {
            gotReplay = true;
            // Capture the anchor BEFORE reset wipes it.
            oldLength = term.buffer.active.length;
            oldViewportY = term.buffer.active.viewportY;
            term.reset();
            term.write(chunk, drainPending);
            return;
          }
          if (rebuilding) { pendingLive.push(chunk); return; }
          attachLive(chunk);
        },
        onReset: () => { term.reset(); resyncSize(); },
      });
      openSockets.add(newSock);
    }

    const sock = socketFactory({
      terminalId,
      replayBytes: initialReplay,
      onData: (chunk) => {
        if (disposed) return;
        if (rebuilding) { pendingLive.push(chunk); return; }
        attachLive(chunk);
      },
      // On reconnect the server replays the scrollback — clear first so it lands
      // clean, then re-sync the PTY size to this view.
      onReset: () => { term.reset(); resyncSize(); },
    });
    openSockets.add(sock);
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

    // A pull past the bottom (overscroll > 0) is still "at bottom" — keep the
    // jump-to-latest arrow hidden during that rubber-band. A pull past the top
    // (overscroll < 0) is genuinely not at bottom, so it falls through.
    const viewportAtBottom = () => {
      const vp = viewportEl();
      if (!vp) return true;
      if (overscroll > 0) return true;
      return vp.scrollHeight - vp.clientHeight - vp.scrollTop < 4 && subPx === 0 && overscroll === 0;
    };
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
    const offScroll = term.onScroll(() => { updateAtBottom(); maybeStartRebuild(); });
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
      // Close whatever socket(s) are currently open — if a rebuild is mid-flight
      // at unmount time, both the old and the new socket are in this set.
      openSockets.forEach((s) => s.close());
      openSockets.clear();
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
      setNote(`Sent ${file.name}`);
    } catch { setNote('Upload failed'); }
    setTimeout(() => setNote(''), 2500);
  }
  function onFiles(files: FileList | null) {
    if (files) for (const f of Array.from(files)) void uploadImage(f);
  }

  // Mobile input: the terminal is read-only to touch (you can only scroll it),
  // so typing happens here and is sent to the PTY as a submitted line. Send the
  // text and the Enter as SEPARATE writes — "text\r" in one write makes the agent
  // TUI treat the \r as a literal newline (message staged, not submitted); a
  // standalone Enter is recognized as submit.
  function sendMobileInput() {
    const v = mobileInput;
    if (!v) return;
    sockRef.current?.send(v);
    setTimeout(() => sockRef.current?.send('\r'), 80);
    clearMobileInput();
  }

  const { actions: softActions, slash: slashCmds } = keysFor(meta?.type);
  const slashFilter = slashQuery.trim().toLowerCase();
  const slashResults = slashFilter
    ? slashCmds.filter((c) => c.cmd.toLowerCase().includes(slashFilter) || c.desc.toLowerCase().includes(slashFilter))
    : slashCmds;
  const closeSlash = () => { setSlashOpen(false); setSlashQuery(''); };

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
      <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', ...(isMobile ? { margin: '2px 8px', borderRadius: 12, background: 'var(--color-terminal)' } : {}) }}>
        {/* inset (not padding): FitAddon measures the host's width, and padding on
            the host makes it over-count columns so the right edge clips. On mobile
            the right inset is trimmed: xterm's column quantization + scrollbar leave
            ~7px unused on the right, so a smaller right inset re-centres the text
            (and gains a column or two of width). */}
        <div ref={hostRef} style={{ position: 'absolute', ...(isMobile ? { top: 0, bottom: 12, left: 3, right: 3 } : { inset: 15 }) }} />
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
        {loadingOlder && (
          <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 6, background: 'rgba(10,10,12,.85)', color: 'var(--color-accent)', fontSize: 12, fontWeight: 500, padding: '5px 11px', borderRadius: 9, pointerEvents: 'none' }}>Loading earlier output…</div>
        )}
        {drop && (
          <div style={{ position: 'absolute', inset: 8, border: '2px dashed var(--color-accent)', borderRadius: 10, background: 'rgba(62,207,106,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: 'var(--color-accent)', fontSize: 14, fontWeight: 600 }}>Drop image to send to the agent</div>
        )}
        {note && (
          <div style={{ position: 'absolute', left: 14, bottom: 14, zIndex: 6, background: 'rgba(10,10,12,.85)', color: 'var(--color-accent)', fontSize: 12, fontWeight: 500, padding: '5px 11px', borderRadius: 9, pointerEvents: 'none' }}>{note}</div>
        )}
      </div>
      {isMobile && (
        <>
          {/* One fixed-width row of action keys plus a "/" that opens the
              searchable slash-command sheet — no horizontal scrolling. */}
          <div style={{ display: 'flex', gap: 6, padding: '6px 8px', background: 'var(--color-pane)', flexShrink: 0 }}>
            {softActions.map((k) => (
              <button key={k.label} title={k.title}
                onMouseDown={(e) => e.preventDefault() /* don't steal focus / dismiss the keyboard */}
                onClick={() => sockRef.current?.send(k.seq) /* fire on tap, not on press */}
                style={{ flex: '1 1 0', minWidth: 0, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12, color: 'var(--color-text-primary)', font: '500 14px var(--font-mono)', cursor: 'pointer' }}>
                {k.Icon ? <k.Icon size={18} weight="bold" /> : k.label}
              </button>
            ))}
            {slashCmds.length > 0 && (
              <button title="Slash commands"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setSlashQuery(''); setSlashOpen(true); }}
                style={{ flex: '1 1 0', minWidth: 0, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12, color: 'var(--color-accent)', font: '600 17px var(--font-mono)', cursor: 'pointer' }}>
                /
              </button>
            )}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); sendMobileInput(); }}
            style={{ display: 'flex', gap: 8, padding: '2px 8px 8px', background: 'var(--color-pane)', flexShrink: 0, alignItems: 'center', paddingBottom: 'calc(8px + env(safe-area-inset-bottom))' }}
          >
            <InputActionsMenu
              onAddFile={() => termFileInputRef.current?.click()}
              onDictate={() => void dictation.start()}
              dictateDisabled={!sttConfigured}
              dictateHint="Set up in Settings → Transcription"
            />
            <input ref={termFileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files); e.currentTarget.value = ''; }} />
            {dictation.state !== 'idle' ? (
              <DictationControl dictation={dictation} />
            ) : (
              <input
                value={mobileInput}
                onChange={(e) => setMobileInput(e.target.value)}
                placeholder="Type a message or command…"
                autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                enterKeyHint="send"
                /* 16px font avoids iOS auto-zoom on focus */
                style={{ flex: 1, minWidth: 0, height: 40, padding: '0 13px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12, color: 'var(--color-text-primary)', fontSize: 16 }}
              />
            )}
            <button type="submit" style={{ height: 40, padding: '0 18px', flexShrink: 0, background: 'var(--color-accent)', color: '#06140B', border: 'none', borderRadius: 12, fontWeight: 600, fontSize: 15, cursor: 'pointer' }}>Send</button>
          </form>
        </>
      )}
      {/* Slash-command sheet. Portaled to <body> so position:fixed isn't trapped
          by the mobile slide-rail's transform (which would shift it off-screen). */}
      {isMobile && slashOpen && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={closeSlash} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)' }} />
          <div style={{ position: 'relative', background: 'var(--color-pane)', borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '72vh', display: 'flex', flexDirection: 'column', animation: 'dispatchSlideUp .2s cubic-bezier(.4,0,.2,1)', boxShadow: '0 -12px 40px -10px rgba(0,0,0,.6)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 10px' }}>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12 }}>
                <MagnifyingGlass size={17} color="var(--color-text-secondary)" />
                <input
                  value={slashQuery} onChange={(e) => setSlashQuery(e.target.value)}
                  placeholder="Search slash commands…"
                  autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                  style={{ flex: 1, minWidth: 0, height: '100%', background: 'none', border: 'none', outline: 'none', color: 'var(--color-text-primary)', fontSize: 16 }}
                />
              </div>
              <button onClick={closeSlash} title="Close" style={{ height: 40, width: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
                <X size={18} weight="bold" />
              </button>
            </div>
            <div style={{ overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '2px 0 8px' }}>
              {slashResults.map((c) => (
                <button key={c.cmd}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { sockRef.current?.send(c.seq); closeSlash(); }}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, width: '100%', textAlign: 'left', padding: '11px 18px', background: 'none', border: 'none', cursor: 'pointer' }}>
                  <span style={{ font: '600 15px var(--font-mono)', color: 'var(--color-accent)' }}>{c.cmd}</span>
                  <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{c.desc}</span>
                </button>
              ))}
              {slashResults.length === 0 && (
                <div style={{ padding: '20px 18px', color: 'var(--color-text-tertiary)', fontSize: 13 }}>No matching commands</div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
