import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, X, WarningCircle } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { InboxUpload } from '../../api/types';

/**
 * Uploads in flight above a composer (2026-11-05): a tile per file with a progress ring and its
 * percentage, and an × that cancels it before it finishes. A finished upload leaves the tray (the
 * host has done what it does with the file by then); a failed one stays, marked, until its × is
 * tapped. Shared by every composer that uploads to a project's inbox.
 */
export interface Upload {
  id: string;
  name: string;
  /** An object URL for an image's thumbnail; null for other files. */
  preview: string | null;
  fraction: number;
  state: 'uploading' | 'finishing' | 'failed';
  abort: () => void;
}

/**
 * Start uploads and track them. `onUploaded` runs when one finishes (send the file reference,
 * stage the image); while it runs the tile reads "finishing". A cancelled upload never calls it.
 */
export function useInboxUploads(sessionId: string | null | undefined, onUploaded: (res: InboxUpload, file: File) => Promise<void> | void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const done = useRef(onUploaded);
  done.current = onUploaded;
  const live = useRef(new Set<string>());
  const current = useRef<Upload[]>([]);
  current.current = uploads;

  // Unmount: cancel what is still going and free the thumbnails.
  useEffect(() => () => {
    for (const u of current.current) { if (u.state === 'uploading') u.abort(); if (u.preview) URL.revokeObjectURL(u.preview); }
  }, []);

  const patch = (id: string, p: Partial<Upload>) => setUploads((cur) => cur.map((u) => (u.id === id ? { ...u, ...p } : u)));
  const drop = useCallback((id: string) => {
    live.current.delete(id);
    setUploads((cur) => {
      const u = cur.find((x) => x.id === id);
      if (u?.preview) URL.revokeObjectURL(u.preview);
      return cur.filter((x) => x.id !== id);
    });
  }, []);

  const start = useCallback((file: File) => {
    if (!sessionId) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const preview = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
    const { promise, abort } = api.uploadInboxTracked(sessionId, file, (fraction) => patch(id, { fraction }));
    live.current.add(id);
    setUploads((cur) => [...cur, { id, name: file.name || 'file', preview, fraction: 0, state: 'uploading', abort }]);
    promise.then(async (res) => {
      if (!live.current.has(id)) return; // cancelled as it finished
      patch(id, { fraction: 1, state: 'finishing' });
      try { await done.current(res, file); drop(id); }
      catch { patch(id, { state: 'failed' }); }
    }).catch(() => {
      if (live.current.has(id)) patch(id, { state: 'failed' });
    });
  }, [sessionId, drop]);

  /** The tile's ×: cancel a running upload, or clear a failed one. */
  const cancel = useCallback((id: string) => {
    const u = current.current.find((x) => x.id === id);
    live.current.delete(id); // before abort: its rejection must not mark the tile failed
    if (u?.state === 'uploading') u.abort();
    drop(id);
  }, [drop]);

  return { uploads, start, cancel, busy: uploads.some((u) => u.state !== 'failed') };
}

function Ring({ fraction }: { fraction: number }) {
  const r = 15, c = 2 * Math.PI * r;
  return (
    <svg width={38} height={38} viewBox="0 0 38 38" aria-hidden="true" style={{ position: 'absolute' }}>
      <circle cx={19} cy={19} r={r} fill="none" stroke="color-mix(in srgb, var(--color-on-media) 25%, transparent)" strokeWidth={3} />
      <circle cx={19} cy={19} r={r} fill="none" stroke="var(--color-on-media)" strokeWidth={3} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} transform="rotate(-90 19 19)" style={{ transition: 'stroke-dashoffset .15s linear' }} />
    </svg>
  );
}

export function UploadTray({ uploads, onCancel }: { uploads: Upload[]; onCancel: (id: string) => void }) {
  if (!uploads.length) return null;
  return (
    <div data-testid="upload-tray" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
      {uploads.map((u) => {
        const pct = Math.round(u.fraction * 100);
        const label = u.state === 'failed' ? `${u.name}: upload failed` : u.state === 'finishing' ? `${u.name}: sending` : `${u.name}: uploading ${pct}%`;
        return (
          <div key={u.id} role="status" aria-label={label} title={label}
            style={{ position: 'relative', width: 60, height: 60, flex: 'none', borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: `1px solid ${u.state === 'failed' ? 'var(--color-status-red)' : 'var(--color-border)'}`, background: 'var(--color-elevated)' }}>
            {u.preview
              ? <img src={u.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)' }}><FileText size={24} /></div>}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: u.state === 'failed' ? 'color-mix(in srgb, color-mix(in srgb, var(--color-status-red) 25%, var(--color-media-bg)) 55%, transparent)' : 'color-mix(in srgb, var(--color-media-bg) 50%, transparent)', color: 'var(--color-on-media)' }}>
              {u.state === 'failed'
                ? <WarningCircle size={22} weight="fill" color="var(--color-status-red)" />
                : <><Ring fraction={u.state === 'finishing' ? 1 : u.fraction} /><span style={{ position: 'relative', font: '600 10.5px var(--font-mono)' }}>{u.state === 'finishing' ? '✓' : `${pct}%`}</span></>}
            </div>
            <button type="button" aria-label={u.state === 'failed' ? `Remove ${u.name}` : `Cancel upload of ${u.name}`} onClick={() => onCancel(u.id)}
              style={{ position: 'absolute', top: 3, right: 3, width: 20, height: 20, padding: 0, borderRadius: '50%', border: 'none', background: 'color-mix(in srgb, var(--color-media-bg) 70%, transparent)', color: 'var(--color-on-media)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <X size={11} weight="bold" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
