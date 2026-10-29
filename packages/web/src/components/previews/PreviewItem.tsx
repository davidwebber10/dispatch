import { useEffect, useState, type CSSProperties } from 'react';
import { Copy, Check, Trash, ArrowSquareOut, Image as ImageIcon, FilePdf, FileHtml, FileText, FileCsv, Code, X } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { Preview, PreviewFile } from '../../api/types';
import { api, previewFileUrl } from '../../api/client';
import { ImageLightbox } from '../ChatImage';
import { Markdown } from '../Markdown';

/**
 * One preview, the same on the phone's sheet and the desktop view: title, context line, note,
 * the text with Copy, and a chip per file. An image opens the app's lightbox; md/txt/csv/json
 * open an in-app reader with Copy; pdf and html open in a new tab (the browser's own viewer;
 * html runs sandboxed, see routes/previews.ts).
 */
export function previewFileKind(f: Pick<PreviewFile, 'mime'>): 'image' | 'pdf' | 'html' | 'markdown' | 'text' {
  if (f.mime.startsWith('image/')) return 'image';
  if (f.mime === 'application/pdf') return 'pdf';
  if (f.mime === 'text/html') return 'html';
  if (f.mime === 'text/markdown') return 'markdown';
  return 'text';
}

const KIND_ICON: Record<ReturnType<typeof previewFileKind>, Icon> = { image: ImageIcon, pdf: FilePdf, html: FileHtml, markdown: FileText, text: FileCsv };

/** Copy a string; falls back to a hidden textarea where the async clipboard is not available (plain http on a phone). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

const timeOf = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
};

const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const chipStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', height: 34, padding: '0 11px', borderRadius: 9,
  border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)',
  fontSize: 13, cursor: 'pointer', textDecoration: 'none',
};

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => { if (state === 'idle') return; const t = setTimeout(() => setState('idle'), 1600); return () => clearTimeout(t); }, [state]);
  return (
    <button type="button" aria-label={label} title={label} onClick={() => void copyText(text).then((ok) => setState(ok ? 'copied' : 'error'))}
      style={{ ...chipStyle, height: 30, padding: '0 10px', background: state === 'copied' ? 'var(--color-accent)' : 'var(--color-elevated)', color: state === 'copied' ? '#08240F' : 'var(--color-text-primary)', fontWeight: 600, fontSize: 12.5 }}>
      {state === 'copied' ? <Check size={14} weight="bold" /> : <Copy size={14} />}
      {state === 'copied' ? 'Copied' : state === 'error' ? 'Could not copy' : label}
    </button>
  );
}

/** The in-app reader for a text-like file: Markdown rendered, others monospace; Copy on top. */
function TextFileOverlay({ preview, k, onClose }: { preview: Preview; k: number; onClose: () => void }) {
  const file = preview.files[k];
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    api.previewFileText(preview.id, k).then((t) => { if (on) setBody(t); }).catch(() => { if (on) setError('Could not load the file.'); });
    return () => { on = false; };
  }, [preview.id, k]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const kind = previewFileKind(file);
  return (
    <div role="dialog" aria-label={file.name} onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 820, maxHeight: '92dvh', display: 'flex', flexDirection: 'column', background: 'var(--color-pane)', borderRadius: '14px 14px 0 0', border: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--color-border)' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, fontSize: 14 }}>{file.name}</span>
          {body !== null && <CopyButton text={body} />}
          <button type="button" aria-label="Close" onClick={onClose} style={{ ...chipStyle, height: 30, width: 30, padding: 0, justifyContent: 'center' }}><X size={14} weight="bold" /></button>
        </div>
        <div style={{ overflow: 'auto', padding: '14px 16px calc(14px + env(safe-area-inset-bottom))', minHeight: 120 }}>
          {error && <div role="alert" style={{ color: 'var(--color-status-red)', fontSize: 13 }}>{error}</div>}
          {body === null && !error && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>Loading…</div>}
          {body !== null && (kind === 'markdown'
            ? <Markdown source={body} />
            : <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '13px/1.5 var(--font-mono)', color: 'var(--color-text-primary)' }}>{body}</pre>)}
        </div>
      </div>
    </div>
  );
}

export function PreviewItem({ preview, onDelete, showProject = true }: { preview: Preview; onDelete?: (id: string) => void; showProject?: boolean }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [reader, setReader] = useState<number | null>(null);
  const unseen = !preview.seenAt;

  const open = (k: number) => {
    const f = preview.files[k];
    const kind = previewFileKind(f);
    if (kind === 'image') setLightbox(k);
    else if (kind === 'pdf' || kind === 'html') window.open(previewFileUrl(preview.id, k), '_blank', 'noopener');
    else setReader(k);
  };

  const context = [showProject ? preview.sessionName : null, preview.terminalLabel, timeOf(preview.createdAt)].filter(Boolean).join(' · ');

  return (
    <div data-testid="preview-item" data-unseen={unseen ? 'true' : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '12px 14px', borderRadius: 12, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {unseen && <span aria-label="New" title="New" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-accent)', marginTop: 7, flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>{preview.title}</div>
          {context && <div style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', marginTop: 2 }}>{context}</div>}
        </div>
        {onDelete && (
          <button type="button" aria-label="Delete preview" title="Delete" onClick={() => onDelete(preview.id)}
            style={{ width: 28, height: 28, padding: 0, border: 'none', borderRadius: 7, background: 'transparent', color: 'var(--color-text-tertiary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Trash size={15} />
          </button>
        )}
      </div>
      {preview.note && <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{preview.note}</div>}
      {preview.text && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <pre data-testid="preview-text" style={{ margin: 0, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'all', WebkitUserSelect: 'all', font: '13px/1.5 var(--font-mono)', color: 'var(--color-text-primary)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 9, padding: '10px 12px' }}>{preview.text}</pre>
          <div><CopyButton text={preview.text} label="Copy text" /></div>
        </div>
      )}
      {preview.files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {preview.files.map((f, k) => {
            const kind = previewFileKind(f);
            const I = KIND_ICON[kind];
            const external = kind === 'pdf' || kind === 'html';
            return (
              <button key={k} type="button" onClick={() => open(k)} title={`${f.name} · ${fmtSize(f.size)}`} style={chipStyle}>
                <I size={16} style={{ flexShrink: 0 }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                {external ? <ArrowSquareOut size={13} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} /> : kind !== 'image' ? <Code size={13} style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} /> : null}
              </button>
            );
          })}
        </div>
      )}
      {lightbox !== null && <ImageLightbox src={previewFileUrl(preview.id, lightbox)} alt={preview.files[lightbox]?.name} onClose={() => setLightbox(null)} />}
      {reader !== null && <TextFileOverlay preview={preview} k={reader} onClose={() => setReader(null)} />}
    </div>
  );
}
