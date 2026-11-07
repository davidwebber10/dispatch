import { useEffect, useState, type CSSProperties } from 'react';
import { Copy, Check, Trash, Image as ImageIcon, FilePdf, FileHtml, FileText, FileCsv } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { Preview, PreviewFile } from '../../api/types';
import { api, previewFileUrl } from '../../api/client';
import { FileViewer, type ViewerFile } from '../viewer/FileViewer';

/**
 * One preview, the same on the phone's sheet and the desktop view: title, context line, note,
 * the text with Copy, and a chip per file. Any file opens the full-screen FileViewer on all of
 * the preview's files at that one (2026-11-07): swipe or step between them, zoom a picture,
 * read markdown and text in place, a pdf or html page in a frame with Open for a new tab
 * (html runs sandboxed, see routes/previews.ts).
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

/** "Today 9:46 PM", "Yesterday 9:46 PM", or "Nov 4, 9:46 PM". */
export const timeOf = (iso: string, now: Date = new Date()): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${t}`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
};

const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const chipStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', height: 34, padding: '0 11px', borderRadius: 'var(--radius-md)',
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

export function PreviewItem({ preview, onDelete, showProject = true }: { preview: Preview; onDelete?: (id: string) => void; showProject?: boolean }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const unseen = !preview.seenAt;

  const open = (k: number) => setViewing(k);
  const viewerFiles: ViewerFile[] = preview.files.map((f, k) => ({
    src: previewFileUrl(preview.id, k), name: f.name, mime: f.mime, size: f.size,
    loadText: () => api.previewFileText(preview.id, k),
  }));

  // The thread it came from; the date and time sit on their own beside the title, never cut off.
  const context = [showProject ? preview.sessionName : null, preview.terminalLabel].filter(Boolean).join(' · ');
  const when = timeOf(preview.createdAt);

  return (
    <div data-testid="preview-item" data-unseen={unseen ? 'true' : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '12px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {unseen && <span aria-label="New" title="Not viewed yet" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)', marginTop: 6, flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>{preview.title}</span>
            {when && <span data-testid="preview-when" style={{ flexShrink: 0, font: '400 11px var(--font-mono)', color: unseen ? 'var(--color-accent)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{when}</span>}
          </div>
          {/* One short line: a long thread name is cut, never wrapped. */}
          {context && <div title={context} style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{context}</div>}
        </div>
        {onDelete && (
          <button type="button" aria-label="Delete preview" title="Delete" onClick={() => onDelete(preview.id)}
            style={{ width: 28, height: 28, padding: 0, border: 'none', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--color-text-tertiary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Trash size={15} />
          </button>
        )}
      </div>
      {preview.note && <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' }}>{preview.note}</div>}
      {preview.text && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <pre data-testid="preview-text" style={{ margin: 0, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'all', WebkitUserSelect: 'all', font: '13px/1.5 var(--font-mono)', color: 'var(--color-text-primary)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>{preview.text}</pre>
          <div><CopyButton text={preview.text} label="Copy text" /></div>
        </div>
      )}
      {/* Images are shown as pictures (tap to open); other files are compact chips. */}
      {preview.files.some((f) => previewFileKind(f) === 'image') && (
        <div data-testid="preview-thumbs" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
          {preview.files.map((f, k) => previewFileKind(f) !== 'image' ? null : (
            <button key={k} type="button" onClick={() => open(k)} aria-label={`Open ${f.name}`} title={`${f.name} · ${fmtSize(f.size)}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 0, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', minWidth: 0 }}>
              <img src={previewFileUrl(preview.id, k)} alt="" loading="lazy"
                style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'contain', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-pane)', display: 'block' }} />
              <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
            </button>
          ))}
        </div>
      )}
      {preview.files.some((f) => previewFileKind(f) !== 'image') && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {preview.files.map((f, k) => {
            const kind = previewFileKind(f);
            if (kind === 'image') return null;
            const I = KIND_ICON[kind];
            return (
              <button key={k} type="button" onClick={() => open(k)} title={`${f.name} · ${fmtSize(f.size)}`} style={chipStyle}>
                <I size={16} style={{ flexShrink: 0 }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <span style={{ flexShrink: 0, font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{fmtSize(f.size)}</span>
              </button>
            );
          })}
        </div>
      )}
      {/* The viewer portals to <body> above the phone's sheet. */}
      {viewing !== null && <FileViewer files={viewerFiles} index={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
