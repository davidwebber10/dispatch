import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOut, CaretLeft, CaretRight, Check, Copy, DownloadSimple, FileCsv, FileHtml, FilePdf, FileText, MagnifyingGlassMinus, MagnifyingGlassPlus, ShareNetwork, X } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { clipboardImageSupported, copyImageToClipboard, copyText, loadImageBlob } from '../../lib/clipboard';
import { isSafeDownloadUrl } from '../../lib/safeUrl';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Markdown } from '../Markdown';
import { FIT, atFit, distance, midpoint, panTo, swipeOutcome, toggleZoom, zoomAt, type Point, type Size, type View } from './zoom';

/**
 * The full-screen file viewer (2026-11-07): one or more files, swiped through on a phone and
 * stepped through with arrows and keys on a desktop.
 *
 * - An image zooms around the pinch, the cursor under the wheel, or the double-tapped spot, and
 *   pans inside its edges. At the fit, a drag swipes to the next file, and a pull down closes.
 * - Markdown and text render in place, with Copy. A pdf or an html page shows in a frame, with
 *   Open for the browser's own viewer (a phone shows only the first pdf page in a frame).
 * - Copy, Share (a phone's share sheet, so a screenshot can go to Photos), Download, Open.
 *
 * It is the chat lightbox too (ChatImage's ImageLightbox hands it one image), so every picture in
 * the app gets the same gestures.
 */
export interface ViewerFile {
  src: string;
  name: string;
  mime: string;
  size?: number;
  /** The text of a markdown/text file; without it the file is fetched from `src`. */
  loadText?: () => Promise<string>;
}

export type ViewerKind = 'image' | 'pdf' | 'html' | 'markdown' | 'text';

export function viewerKind(mime: string): ViewerKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/markdown') return 'markdown';
  return 'text';
}

const KIND_ICON: Record<Exclude<ViewerKind, 'image'>, Icon> = { pdf: FilePdf, html: FileHtml, markdown: FileText, text: FileCsv };

const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp', 'application/pdf': 'pdf', 'text/html': 'html',
  'text/markdown': 'md', 'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json',
};

function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** The bytes of a file the viewer shows: an image through the clipboard helper (it decodes data: URIs without a request), the rest fetched. */
async function fileBlob(file: ViewerFile): Promise<Blob> {
  if (viewerKind(file.mime) === 'image') return loadImageBlob(file.src);
  const res = await fetch(file.src);
  if (!res.ok) throw new Error(`GET ${file.src} failed: ${res.status}`);
  return res.blob();
}

/** Save a file. A name with an extension is kept; otherwise the blob's type names it (a chat image is named after its alt). */
export async function downloadFile(file: ViewerFile): Promise<void> {
  try {
    const blob = await fileBlob(file);
    const ext = MIME_EXT[blob.type] ?? MIME_EXT[file.mime] ?? 'png';
    const name = /\.[a-z0-9]{1,5}$/i.test(file.name) ? file.name : `${(file.name && slugify(file.name)) || `image-${Date.now()}`}.${ext}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // Best-effort fallback (the fetch was blocked): a link at the address itself. Never for a
    // javascript: or other script address, which would run on the app's origin.
    if (!isSafeDownloadUrl(file.src)) return;
    const a = document.createElement('a');
    a.href = file.src; a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  }
}

/** A phone's share sheet can take a file (Photos, Messages, Files). Desktop browsers mostly cannot, so the button only shows where it works. */
function shareSupported(): boolean {
  const n = typeof navigator !== 'undefined' ? (navigator as Navigator & { canShare?: (d: ShareData) => boolean }) : null;
  if (!n || typeof n.share !== 'function' || typeof n.canShare !== 'function' || typeof File !== 'function') return false;
  try { return n.canShare({ files: [new File([''], 'probe.png', { type: 'image/png' })] }); } catch { return false; }
}

async function shareFile(file: ViewerFile): Promise<void> {
  const blob = await fileBlob(file);
  const ext = MIME_EXT[blob.type] ?? MIME_EXT[file.mime] ?? 'bin';
  const name = /\.[a-z0-9]{1,5}$/i.test(file.name) ? file.name : `${slugify(file.name) || 'file'}.${ext}`;
  const f = new File([blob], name, { type: blob.type || file.mime });
  try { await navigator.share({ files: [f], title: file.name }); } catch { /* the user closed the sheet */ }
}

const btn = (disabled = false, accent = false): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, flexShrink: 0,
  borderRadius: 'var(--radius-md)', background: accent ? 'var(--color-accent)' : 'rgba(28,28,32,.82)', border: '1px solid rgba(255,255,255,.12)',
  color: accent ? '#08240F' : 'var(--color-text-primary)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1, padding: 0,
});

type Gesture =
  | { mode: 'none' }
  | { mode: 'pinch'; start: View; dist: number; mid: Point }
  | { mode: 'pan'; start: View; from: Point; moved: boolean }
  | { mode: 'swipe'; from: Point; at: number; axis: 'x' | 'y' | null }
  | { mode: 'drag'; start: View; from: Point; moved: boolean };

const NONE: Gesture = { mode: 'none' };

export function FileViewer({ files, index: initial = 0, onClose, label }: { files: ViewerFile[]; index?: number; onClose: () => void; label?: string }) {
  const n = files.length;
  const [index, setIndex] = useState(() => Math.min(Math.max(0, initial), Math.max(0, n - 1)));
  const [view, setView] = useState<View>(FIT);
  // A one-finger drag at the fit: the strip follows the finger (x) or the picture sinks (y).
  const [swipe, setSwipe] = useState<Point | null>(null);
  const [live, setLive] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'error'>('idle');
  const [text, setText] = useState<Record<number, string>>({});
  // The latest view, also between renders: a gesture's end reads it in the same task as the
  // move that set it, before React has drawn that move.
  const viewRef = useRef(view);
  viewRef.current = view;
  const commit = (next: View) => { viewRef.current = next; setView(next); };
  const gesture = useRef<Gesture>(NONE);
  const lastTap = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();
  const file = files[index];
  const kind = file ? viewerKind(file.mime) : 'text';
  const canShare = shareSupported();

  const go = useCallback((i: number) => {
    if (i < 0 || i >= n) { setSwipe(null); return; }
    setIndex(i); setView(FIT); setSwipe(null); setLive(false);
  }, [n]);

  // Sizes for the clamp: the picture at the fit (its layout box, which a transform does not change) and the box it sits in.
  const sizes = (): { picture: Size; stage: Size } => {
    const img = imgRef.current;
    const box = img?.parentElement;
    return {
      picture: { w: img?.clientWidth ?? 0, h: img?.clientHeight ?? 0 },
      stage: { w: box?.clientWidth ?? 0, h: box?.clientHeight ?? 0 },
    };
  };
  // A client point relative to the stage's centre.
  const rel = (clientX: number, clientY: number): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) } : { x: 0, y: 0 };
  };

  // Focus: the dialog takes it on open and gives it back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
      // The opener row can be replaced at turn end: the composer is the next place to type.
      else document.querySelector<HTMLElement>('textarea[aria-label="Message"]')?.focus();
    };
  }, []);

  // Keys: Escape closes, arrows step, + - 0 zoom; Tab stays inside the dialog. On the window in the
  // capture phase: a click on the picture moves focus to the body, and a viewer over another layer
  // (the doc viewer) takes Escape first.
  useEffect(() => {
    function trapTab(e: KeyboardEvent) {
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
      if (items.length === 0) return;
      const first = items[0]; const last = items[items.length - 1];
      const active = document.activeElement;
      if (!dialogRef.current?.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Tab') { trapTab(e); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); return; }
      if (kind !== 'image') return;
      const { picture, stage } = sizes();
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setView((v) => zoomAt(v, v.scale * 1.5, { x: 0, y: 0 }, picture, stage)); }
      else if (e.key === '-') { e.preventDefault(); setView((v) => zoomAt(v, v.scale / 1.5, { x: 0, y: 0 }, picture, stage)); }
      else if (e.key === '0') { e.preventDefault(); setView(FIT); }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, go, index, kind]);

  // The wheel zooms around the cursor; a native listener, because React's is passive and could not stop the page from scrolling or zooming.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (kind !== 'image') return;
      e.preventDefault();
      const { picture, stage } = sizes();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      setView((v) => zoomAt(v, v.scale * factor, rel(e.clientX, e.clientY), picture, stage));
    }
    // While a gesture owns the finger, the page under the viewer must not scroll or zoom.
    function onTouchMove(e: TouchEvent) {
      const g = gesture.current;
      if (g.mode === 'pinch' || g.mode === 'pan' || (g.mode === 'swipe' && g.axis === 'x') || (g.mode === 'swipe' && kind === 'image')) {
        if (e.cancelable) e.preventDefault();
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('touchmove', onTouchMove); };
  }, [kind]);

  // Text files load once each.
  useEffect(() => {
    if ((kind !== 'markdown' && kind !== 'text') || text[index] !== undefined) return;
    let on = true;
    const load = file.loadText ?? (async () => { const r = await fetch(file.src); if (!r.ok) throw new Error(String(r.status)); return r.text(); });
    load().then((t) => { if (on) setText((m) => ({ ...m, [index]: t })); }).catch(() => { if (on) setText((m) => ({ ...m, [index]: '\u0000' })); });
    return () => { on = false; };
  }, [index, kind, file, text]);

  // The strip keeps the current thumbnail in view.
  useEffect(() => {
    const el = stripRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [index]);

  useEffect(() => {
    if (copied === 'idle') return;
    const t = setTimeout(() => setCopied('idle'), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  if (!file) return null;

  // ── touch ──────────────────────────────────────────────────────────────────────────────────
  const pt = (t: React.Touch): Point => ({ x: t.clientX, y: t.clientY });

  function onTouchStart(e: ReactTouchEvent<HTMLDivElement>) {
    const v = viewRef.current;
    if (kind === 'image' && e.touches.length === 2) {
      const a = pt(e.touches[0]); const b = pt(e.touches[1]);
      const m = midpoint(a, b);
      gesture.current = { mode: 'pinch', start: v, dist: distance(a, b), mid: rel(m.x, m.y) };
      setLive(true);
      return;
    }
    if (e.touches.length !== 1) return;
    const p = pt(e.touches[0]);
    if (kind === 'image' && !atFit(v)) { gesture.current = { mode: 'pan', start: v, from: p, moved: false }; setLive(true); return; }
    gesture.current = { mode: 'swipe', from: p, at: Date.now(), axis: null };
  }

  function onTouchMove(e: ReactTouchEvent<HTMLDivElement>) {
    const g = gesture.current;
    const { picture, stage } = sizes();
    if (g.mode === 'pinch' && e.touches.length === 2) {
      const a = pt(e.touches[0]); const b = pt(e.touches[1]);
      const m = midpoint(a, b); const now = rel(m.x, m.y);
      const scale = g.start.scale * (distance(a, b) / Math.max(1, g.dist));
      commit(zoomAt(g.start, scale, g.mid, picture, stage, { x: now.x - g.mid.x, y: now.y - g.mid.y }));
    } else if (g.mode === 'pan' && e.touches.length === 1) {
      const p = pt(e.touches[0]);
      const travel = { x: p.x - g.from.x, y: p.y - g.from.y };
      if (Math.hypot(travel.x, travel.y) >= 8) g.moved = true;
      commit(panTo(g.start, travel, picture, stage));
    } else if (g.mode === 'swipe' && e.touches.length === 1) {
      const p = pt(e.touches[0]);
      const travel = { x: p.x - g.from.x, y: p.y - g.from.y };
      // The first clear move picks the axis, so a vertical scroll of a text file never also swipes.
      if (!g.axis && Math.hypot(travel.x, travel.y) >= 8) g.axis = Math.abs(travel.x) >= Math.abs(travel.y) ? 'x' : 'y';
      if (g.axis === 'x') setSwipe({ x: travel.x, y: 0 });
      else if (g.axis === 'y' && kind === 'image') setSwipe({ x: 0, y: Math.max(0, travel.y) });
    }
  }

  // A tap. Two in a row on a picture toggle the zoom around the spot (also while zoomed in).
  function tap(t: React.Touch | undefined) {
    const now = Date.now();
    if (kind === 'image' && t && now - lastTap.current < 300) {
      lastTap.current = 0;
      const { picture, stage } = sizes();
      commit(toggleZoom(viewRef.current, rel(t.clientX, t.clientY), picture, stage));
    } else lastTap.current = now;
  }

  function onTouchEnd(e: ReactTouchEvent<HTMLDivElement>) {
    const g = gesture.current;
    const v = viewRef.current;
    if (g.mode === 'pinch') {
      if (e.touches.length >= 2) return;
      if (e.touches.length === 1) {
        // One finger lifted mid-pinch: the other goes on panning, or idles at the fit.
        gesture.current = atFit(v) ? NONE : { mode: 'pan', start: v, from: pt(e.touches[0]), moved: true };
        if (atFit(v)) { commit(FIT); setLive(false); }
        return;
      }
      gesture.current = NONE; setLive(false);
      if (atFit(v)) commit(FIT);
      return;
    }
    if (g.mode === 'pan') {
      if (e.touches.length > 0) return;
      gesture.current = NONE; setLive(false);
      if (!g.moved) tap(e.changedTouches[0]);
      return;
    }
    if (g.mode === 'swipe') {
      if (e.touches.length > 0) return;
      gesture.current = NONE;
      const t = e.changedTouches[0];
      const travel = t ? { x: t.clientX - g.from.x, y: t.clientY - g.from.y } : { x: 0, y: 0 };
      if (!g.axis) { tap(t); setSwipe(null); return; }
      const outcome = swipeOutcome(travel, Date.now() - g.at);
      if (outcome === 'next') go(index + 1);
      else if (outcome === 'prev') go(index - 1);
      else if (outcome === 'close' && kind === 'image') onClose();
      else setSwipe(null);
    }
  }

  // ── mouse ──────────────────────────────────────────────────────────────────────────────────
  function onMouseDown(e: ReactMouseEvent<HTMLImageElement>) {
    if (e.button !== 0 || atFit(viewRef.current)) return;
    e.preventDefault();
    gesture.current = { mode: 'drag', start: viewRef.current, from: { x: e.clientX, y: e.clientY }, moved: false };
    setLive(true);
    const move = (ev: MouseEvent) => {
      const g = gesture.current;
      if (g.mode !== 'drag') return;
      const travel = { x: ev.clientX - g.from.x, y: ev.clientY - g.from.y };
      if (Math.hypot(travel.x, travel.y) > 3) g.moved = true;
      const { picture, stage } = sizes();
      commit(panTo(g.start, travel, picture, stage));
    };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      // The click that ends a drag must not close the viewer: the mode is cleared a tick later.
      setTimeout(() => { gesture.current = NONE; }, 0);
      setLive(false);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  function onDoubleClick(e: ReactMouseEvent<HTMLImageElement>) {
    const { picture, stage } = sizes();
    setView((v) => toggleZoom(v, rel(e.clientX, e.clientY), picture, stage));
  }

  // A click on the dark backdrop closes (not the end of a drag, and not a tap that the swipe code already handled).
  function onBackdropClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.backdrop) return;
    const g = gesture.current;
    if (g.mode === 'drag' && g.moved) return;
    onClose();
  }

  // ── actions ────────────────────────────────────────────────────────────────────────────────
  async function copy() {
    try {
      if (kind === 'image') { if (!clipboardImageSupported()) return; await copyImageToClipboard(file.src); }
      else { const t = text[index]; if (t === undefined || t === '\u0000') return; await copyText(t); }
      setCopied('copied');
    } catch { setCopied('error'); }
  }
  const zoom = (factor: number) => { const { picture, stage } = sizes(); setView((v) => zoomAt(v, v.scale * factor, { x: 0, y: 0 }, picture, stage)); };

  const external = kind === 'pdf' || kind === 'html';
  const copyLabel = kind === 'image' ? 'Copy image' : 'Copy text';
  const copyOk = kind === 'image' ? clipboardImageSupported() : (text[index] !== undefined && text[index] !== '\u0000');
  const copyTitle = kind === 'image' && !clipboardImageSupported() ? 'Copy not supported in this browser'
    : copied === 'copied' ? 'Copied!' : copied === 'error' ? 'Copy failed — try again' : copyLabel;
  const transition = live || swipe ? 'none' : 'transform 160ms ease-out';
  const sink = swipe && swipe.y > 0 ? swipe.y : 0;
  const barPad = mobile ? 58 : 60;

  const slides: number[] = [];
  for (let i = Math.max(0, index - 1); i <= Math.min(n - 1, index + 1); i++) slides.push(i);

  return createPortal(
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={label ?? file.name ?? 'File viewer'}
      style={{ position: 'fixed', inset: 0, zIndex: 1300, background: `rgba(0,0,0,${Math.max(0.35, 0.92 - sink / 400)})`, display: 'flex', flexDirection: 'column', userSelect: 'none', WebkitUserSelect: 'none', overscrollBehavior: 'contain' }}>
      {/* top bar: close, name and position, actions */}
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3, display: 'flex', alignItems: 'center', gap: 8, padding: 'max(10px, env(safe-area-inset-top)) 12px 10px', background: 'linear-gradient(rgba(0,0,0,.65), rgba(0,0,0,0))', pointerEvents: 'none' }}>
        <button ref={closeRef} type="button" onClick={onClose} title="Close" aria-label="Close" style={{ ...btn(), pointerEvents: 'auto' }}><X size={18} weight="bold" /></button>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, pointerEvents: 'auto' }}>
          {file.name && <span style={{ fontSize: 13.5, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 1px 2px rgba(0,0,0,.6)' }}>{file.name}</span>}
          {n > 1 && <span aria-label={`File ${index + 1} of ${n}`} style={{ font: '500 11px var(--font-mono)', color: 'rgba(255,255,255,.7)' }}>{index + 1} / {n}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, pointerEvents: 'auto' }}>
          {kind === 'image' && !mobile && (
            <>
              <button type="button" onClick={() => zoom(1 / 1.5)} title="Zoom out (−)" aria-label="Zoom out" style={btn()}><MagnifyingGlassMinus size={17} weight="bold" /></button>
              <button type="button" onClick={() => zoom(1.5)} title="Zoom in (+)" aria-label="Zoom in" style={btn()}><MagnifyingGlassPlus size={17} weight="bold" /></button>
            </>
          )}
          {!external && (
            <button type="button" onClick={() => void copy()} disabled={!copyOk} title={copyTitle} aria-label={copyLabel} style={btn(!copyOk)}>
              {copied === 'copied' ? <Check size={17} weight="bold" color="var(--color-accent)" /> : <Copy size={17} weight="bold" color={copied === 'error' ? 'var(--color-status-red)' : undefined} />}
            </button>
          )}
          {canShare && <button type="button" onClick={() => void shareFile(file)} title="Share" aria-label="Share" style={btn()}><ShareNetwork size={17} weight="bold" /></button>}
          <button type="button" onClick={() => void downloadFile(file)} title={kind === 'image' ? 'Download image' : 'Download'} aria-label={kind === 'image' ? 'Download image' : 'Download file'} style={btn()}><DownloadSimple size={17} weight="bold" /></button>
          {external && <a href={file.src} target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab" style={{ ...btn(false, true), textDecoration: 'none' }}><ArrowSquareOut size={17} weight="bold" /></a>}
        </div>
      </div>

      {/* stage: the strip of slides; one finger swipes it, two zoom the picture */}
      <div ref={stageRef} data-backdrop="1" onClick={onBackdropClick}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}
        style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', touchAction: kind === 'image' ? 'none' : 'pan-y', cursor: 'zoom-out' }}>
        <div data-backdrop="1" style={{ position: 'absolute', inset: 0, transform: `translate(${swipe?.x ?? 0}px, ${sink}px)`, transition: swipe ? 'none' : 'transform 200ms ease-out' }}>
          {slides.map((i) => {
            const f = files[i]; const k = viewerKind(f.mime); const current = i === index;
            return (
              <div key={i} data-backdrop="1" style={{ position: 'absolute', top: 0, bottom: 0, left: `${(i - index) * 100}%`, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: `${barPad}px ${mobile ? 0 : 56}px ${n > 1 ? 76 : 16}px` }}>
                {k === 'image' ? (
                  <img ref={current ? imgRef : undefined} src={f.src} alt={current ? (f.name || '') : ''} draggable={false}
                    onClick={(e) => e.stopPropagation()} onMouseDown={current ? onMouseDown : undefined} onDoubleClick={current ? onDoubleClick : undefined}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', borderRadius: mobile ? 0 : 'var(--radius-md)',
                      transform: current ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined, transition: current ? transition : undefined,
                      cursor: current && !atFit(view) ? 'grab' : 'zoom-out', willChange: 'transform' }} />
                ) : k === 'markdown' || k === 'text' ? (
                  <TextSlide kind={k} name={f.name} body={current ? text[i] : undefined} mobile={mobile} />
                ) : (
                  <FrameSlide file={f} kind={k} mobile={mobile} />
                )}
              </div>
            );
          })}
        </div>
        {!mobile && n > 1 && (
          <>
            <button type="button" onClick={(e) => { e.stopPropagation(); go(index - 1); }} disabled={index === 0} title="Previous (←)" aria-label="Previous file"
              style={{ ...btn(index === 0), position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 40, height: 40, borderRadius: '50%' }}><CaretLeft size={20} weight="bold" /></button>
            <button type="button" onClick={(e) => { e.stopPropagation(); go(index + 1); }} disabled={index === n - 1} title="Next (→)" aria-label="Next file"
              style={{ ...btn(index === n - 1), position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 40, height: 40, borderRadius: '50%' }}><CaretRight size={20} weight="bold" /></button>
          </>
        )}
      </div>

      {/* the strip of files: tap one to jump */}
      {n > 1 && (
        <div ref={stripRef} role="tablist" aria-label="Files" onClick={(e) => e.stopPropagation()}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 3, display: 'flex', gap: 6, padding: `10px 12px max(10px, env(safe-area-inset-bottom))`, overflowX: 'auto', background: 'linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.7))', scrollbarWidth: 'none' }}>
          {files.map((f, i) => {
            const k = viewerKind(f.mime); const on = i === index; const I = k === 'image' ? null : KIND_ICON[k];
            return (
              <button key={i} type="button" role="tab" aria-selected={on} aria-label={f.name} title={f.name} onClick={() => go(i)}
                style={{ width: 48, height: 48, flexShrink: 0, padding: 0, borderRadius: 'var(--radius-sm)', overflow: 'hidden', cursor: 'pointer', background: 'rgba(28,28,32,.9)',
                  border: on ? '2px solid var(--color-accent)' : '2px solid rgba(255,255,255,.14)', opacity: on ? 1 : 0.72, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)' }}>
                {I ? <I size={22} /> : <img src={f.src} alt="" loading="lazy" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Markdown rendered, anything else monospace; scrolls on its own, so a swipe sideways still changes the file. */
function TextSlide({ kind, name, body, mobile }: { kind: 'markdown' | 'text'; name: string; body: string | undefined; mobile: boolean }) {
  return (
    <div onClick={(e) => e.stopPropagation()} aria-label={name}
      style={{ width: '100%', maxWidth: 860, height: '100%', overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y', background: 'var(--color-pane)', border: mobile ? 'none' : '1px solid var(--color-border)', borderRadius: mobile ? 0 : 'var(--radius-lg)', padding: mobile ? '14px 16px' : '20px 24px', userSelect: 'text', WebkitUserSelect: 'text', cursor: 'auto' }}>
      {body === undefined && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>Loading…</div>}
      {body === '\u0000' && <div role="alert" style={{ color: 'var(--color-status-red)', fontSize: 13 }}>Could not load the file.</div>}
      {body !== undefined && body !== '\u0000' && (kind === 'markdown'
        ? <Markdown source={body} />
        : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '13px/1.55 var(--font-mono)', color: 'var(--color-text-primary)' }}>{body}</pre>)}
    </div>
  );
}

/** A pdf or an html page in a frame. The page's own scripts already run in an opaque origin (the daemon's CSP); the frame adds the same sandbox. */
function FrameSlide({ file, kind, mobile }: { file: ViewerFile; kind: 'pdf' | 'html'; mobile: boolean }) {
  return (
    <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: kind === 'html' ? 1100 : 900, height: '100%', display: 'flex', flexDirection: 'column', gap: 8, cursor: 'auto' }}>
      {kind === 'pdf' && mobile && (
        <a href={file.src} target="_blank" rel="noopener noreferrer" style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 14px', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: '#08240F', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
          <ArrowSquareOut size={15} weight="bold" /> Open the full pdf
        </a>
      )}
      <iframe src={file.src} title={file.name} {...(kind === 'html' ? { sandbox: 'allow-scripts' } : {})}
        style={{ flex: 1, width: '100%', border: mobile ? 'none' : '1px solid var(--color-border)', borderRadius: mobile ? 0 : 'var(--radius-lg)', background: '#fff' }} />
    </div>
  );
}
