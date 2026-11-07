import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { useSettings } from '../../stores/settings';
import { listRecordings, deleteRecording, type Recording } from '../../lib/recordings';
import { runTranscription } from '../../lib/transcribeJob';
import { copyText } from '../../lib/clipboard';

/**
 * The dictations kept on this device (owner request 2026-11-07: "a history of recordings … run that
 * transcription again"). Newest first, with the text or the error. Insert puts a transcript in the
 * composer that opened the sheet; Copy works anywhere; Transcribe again sends the saved audio again;
 * Delete removes it. Nothing here leaves the device except a transcription.
 */
const mmss = (ms: number): string => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const when = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const btn: React.CSSProperties = { height: 28, padding: '0 10px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' };

export function RecordingsSheet({ open, onClose, onInsert }: { open: boolean; onClose: () => void; onInsert?: (text: string) => void }) {
  const [rows, setRows] = useState<Recording[] | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const load = () => void listRecordings().then(setRows).catch(() => setRows([]));
  useEffect(() => { if (open) load(); }, [open]);

  const again = async (r: Recording) => {
    const { sttProvider, sttModel, sttSecretName } = useSettings.getState();
    if (!sttProvider || !sttModel || !sttSecretName) { setBusy((b) => ({ ...b, [r.id]: 'Set up dictation in Settings → Dictation first.' })); return; }
    setBusy((b) => ({ ...b, [r.id]: 'Uploading…' }));
    try {
      await runTranscription(r.id, { provider: sttProvider, model: sttModel, secretName: sttSecretName }, (p) => {
        setBusy((b) => ({ ...b, [r.id]: p.phase === 'uploading' ? `Uploading ${Math.round(p.pct * 100)}%` : 'Transcribing…' }));
      });
      setBusy((b) => { const n = { ...b }; delete n[r.id]; return n; });
    } catch (e) {
      setBusy((b) => { const n = { ...b }; delete n[r.id]; return n; });
      void e;
    }
    load();
  };

  return (
    <Modal open={open} sheet title="Recordings" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 6 }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Your last dictations, kept on this device. A failed one can be sent again.</div>
        {rows && rows.length === 0 && <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>No recordings yet.</div>}
        {(rows ?? []).map((r) => (
          <div key={r.id} data-testid="recording-row" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-elevated)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ font: '500 12px var(--font-mono)', color: 'var(--color-text-secondary)' }}>{mmss(r.durationMs)}</span>
              <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{when(r.createdAt)}</span>
              <span style={{ marginLeft: 'auto', font: '500 10px var(--font-mono)', textTransform: 'uppercase', color: r.status === 'done' ? 'var(--color-accent)' : r.status === 'failed' ? 'var(--color-status-red)' : 'var(--color-text-tertiary)' }}>{busy[r.id] ?? (r.status === 'done' ? 'Transcribed' : r.status === 'failed' ? 'Not transcribed' : r.status)}</span>
            </div>
            {r.text && <div style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--color-text-primary)', overflowWrap: 'anywhere', maxHeight: 120, overflow: 'auto' }}>{r.text}</div>}
            {r.status === 'failed' && r.error && <div style={{ fontSize: 12, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{r.error}</div>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {r.text && onInsert && <button type="button" style={btn} onClick={() => { onInsert(r.text!); onClose(); }}>Insert</button>}
              {r.text && <button type="button" style={btn} onClick={() => void copyText(r.text!)}>Copy</button>}
              <button type="button" style={btn} disabled={!!busy[r.id]} onClick={() => void again(r)}>{r.status === 'done' ? 'Transcribe again' : 'Retry'}</button>
              <button type="button" style={{ ...btn, color: 'var(--color-status-red)' }} disabled={!!busy[r.id]} onClick={() => void deleteRecording(r.id).then(load)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
