import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Modal } from '../common/Modal';
import type { EndlessView } from '../../api/types';

/** The view exactly as the model sees it (rendered by the server, spec section 7), and the Chat instructions. */
export function MemoryInspector({ open, onClose, sheet = false }: { open: boolean; onClose: () => void; sheet?: boolean }) {
  const [view, setView] = useState<EndlessView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSaved(false);
    setSaveFailed(false);
    setUnavailable(false);
    setView(null);
    setLoaded(false);
    setLoadFailed(false);
    api.endlessView().then((v) => { if (!cancelled) setView(v); }).catch(() => { if (!cancelled) { setView(null); setUnavailable(true); } });
    api.endlessInstructions()
      .then((r) => { if (!cancelled) { setInstructions(r.text); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [open]);

  const save = async () => {
    setSaveFailed(false);
    try { await api.setEndlessInstructions(instructions); setSaved(true); }
    catch { setSaveFailed(true); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Memory" sheet={sheet}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, width: sheet ? '100%' : 'min(760px, 86vw)' }}>
        <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>
          {unavailable ? 'Memory is unavailable.'
            : view ? `${view.lines.length} lines · ${(view.bytes / 1000).toFixed(1)} KB — the view exactly as the model sees it`
            : 'Loading…'}
        </div>
        {view && (
          <pre data-testid="memory-view"
            style={{ margin: 0, maxHeight: '45vh', overflow: 'auto', padding: 10, borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {view.rendered}
          </pre>
        )}
        <label htmlFor="endless-instructions" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          Chat instructions — placed after the system prompt on every turn and compaction. A change starts a new prompt cache.
        </label>
        <textarea id="endless-instructions" aria-label="Chat instructions" rows={4} disabled={!loaded} value={instructions}
          onChange={(e) => { setInstructions(e.target.value); setSaved(false); }}
          style={{ resize: 'vertical', padding: 10, borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', fontSize: 16, font: 'inherit' }} />
        <div>
          <button type="button" onClick={save} disabled={!loaded}
            style={{ opacity: loaded ? 1 : 0.5, padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--color-accent)', color: '#06140B', cursor: 'pointer', fontWeight: 600 }}>
            {saved ? 'Saved' : 'Save instructions'}
          </button>
          {loadFailed && <span role="alert" style={{ marginLeft: 10, fontSize: 12.5, color: 'var(--color-danger, #e5484d)' }}>Instructions could not be loaded.</span>}
          {saveFailed && <span role="alert" style={{ marginLeft: 10, fontSize: 12.5, color: 'var(--color-danger, #e5484d)' }}>Could not save</span>}
        </div>
      </div>
    </Modal>
  );
}
