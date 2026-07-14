import { useState } from 'react';
import { Modal } from '../common/Modal';
import { AutoArchiveField } from './AutoArchiveField';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { DEFAULT_AUTO_ARCHIVE_MS, getAutoArchiveMs } from '../../lib/autoArchive';
import type { Terminal } from '../../api/types';

/**
 * Edit an existing thread's auto-archive policy. Saves through the dedicated
 * /auto-archive endpoint, which merges server-side — the generic PATCH replaces
 * the config blob wholesale and would wipe transport/role/agentType.
 */
export function AutoArchiveModal({ tab, onClose }: { tab: Terminal; onClose: () => void }) {
  const existing = getAutoArchiveMs(tab.config);
  const [enabled, setEnabled] = useState(existing !== null);
  const [ms, setMs] = useState(existing ?? DEFAULT_AUTO_ARCHIVE_MS);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await api.setAutoArchive(tab.id, enabled, ms);
      await useTabs.getState().loadTabs(tab.sessionId);
      onClose();
    } catch { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Auto-archive thread">
      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
        “{tab.label}” will archive itself once it has been idle this long.
      </div>

      <AutoArchiveField enabled={enabled} ms={ms} onChange={(e, m) => { setEnabled(e); setMs(m); }} />

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button onClick={onClose}
          style={{ flex: 1, height: 38, background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 9, color: 'var(--color-text-primary)', fontWeight: 500, fontSize: 14, cursor: 'pointer' }}>
          Cancel
        </button>
        <button disabled={busy} onClick={() => void save()}
          style={{ flex: 1, height: 38, background: 'var(--color-accent)', border: 'none', borderRadius: 9, color: '#08240F', fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
          Save
        </button>
      </div>
    </Modal>
  );
}
