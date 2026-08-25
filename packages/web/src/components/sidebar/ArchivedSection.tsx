import { useCallback, useEffect, useState } from 'react';
import { ArrowCounterClockwise, CaretDown, CaretRight } from '@phosphor-icons/react';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { THREAD_TYPES } from '../../lib/harnesses';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ThreadLabel } from './ThreadLabel';
import { SectionHeader, ShowMoreRow } from './sectionParts';

const CAP = 10;

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
}

/**
 * Quiet ARCHIVED section at the bottom of a project card. Archive is a soft
 * delete (the daemon keeps the row + external_id), and restore respawns the
 * agent on its original conversation — this section is the only general UI
 * over that. Hidden entirely when the project has no archived threads.
 */
export function ArchivedSection({ sessionId, open, onSelectTab }: { sessionId: string; open: boolean; onSelectTab: (id: string) => void }) {
  const [rows, setRows] = useState<Terminal[] | null>(null); // null = never loaded
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [restoreFailedId, setRestoreFailedId] = useState<string | null>(null);

  // Refetch key: the LIVE tab-id set for this project. An archive removes an id
  // and a restore adds one, while status flips keep the set identical — so this
  // string changes exactly when the archived list may have changed. loadTabs
  // already runs on every session:tabs-changed broadcast (stores/tabs.ts
  // applyEvent), which the daemon fires on manual archives, the auto-archive
  // loop, and restores — so remote changes land here without new socket wiring.
  const liveIds = useTabs((s) => (s.byProject[sessionId] ?? []).map((t) => t.id).slice().sort().join(','));

  const load = useCallback(async () => {
    try {
      const all = await api.listArchivedTerminals(sessionId);
      setRows(all
        .filter((t) => THREAD_TYPES.includes(t.type))
        .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, liveIds, load]);

  async function restore(t: Terminal) {
    try {
      const restored = await api.restoreTerminal(t.id);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== t.id));
      await useTabs.getState().loadTabs(sessionId);
      onSelectTab(restored.id);
    } catch {
      setRestoreFailedId(t.id);
    }
  }

  // Hidden until we know there is something to show; a failed fetch still
  // renders the header so the retry row is reachable.
  if (!failed && (rows === null || rows.length === 0)) return null;

  const items = rows ?? [];
  const visible = expanded ? (showAll ? items : items.slice(0, CAP)) : [];

  return (
    <div style={{ marginTop: 8 }}>
      <div role="button" aria-label="Toggle archived threads" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }} style={{ cursor: 'pointer' }}>
        <SectionHeader label="ARCHIVED" count={items.length}>
          <span style={{ font: '600 9.5px var(--font-mono)', color: 'var(--color-text-tertiary)', background: 'var(--color-elevated)', borderRadius: 9, padding: '0 6px', lineHeight: '15px' }}>{items.length}</span>
          {expanded
            ? <CaretDown size={11} color="var(--color-text-tertiary)" />
            : <CaretRight size={11} color="var(--color-text-tertiary)" />}
        </SectionHeader>
      </div>
      {expanded && failed && (
        <button onClick={(e) => { e.stopPropagation(); void load(); }}
          style={{ display: 'block', width: '100%', padding: '3px 7px', background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
          Couldn't load archived threads. Retry.
        </button>
      )}
      {visible.map((t) => (
        <ArchivedRow key={t.id} tab={t} failed={restoreFailedId === t.id} onRestore={() => void restore(t)} />
      ))}
      {expanded && !showAll && items.length > CAP && <ShowMoreRow count={items.length - CAP} onClick={() => setShowAll(true)} />}
    </div>
  );
}

function ArchivedRow({ tab, failed, onRestore }: { tab: Terminal; failed: boolean; onRestore: () => void }) {
  const [hover, setHover] = useState(false);
  const isMobile = useIsMobile();
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-archived-id={tab.id}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '10px 12px' : '3px 7px', borderRadius: isMobile ? 0 : 5, background: hover ? 'rgba(255,255,255,0.04)' : 'transparent' }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: isMobile ? 15 : 12, color: 'var(--color-text-tertiary)' }}>
        <ThreadLabel tab={tab} />
      </span>
      {failed
        ? <span style={{ font: '400 10px var(--font-mono)', color: 'var(--color-status-red)', flexShrink: 0 }}>Restore failed</span>
        : <span style={{ font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{shortDate(tab.archivedAt)}</span>}
      {(hover || isMobile) && (
        <button title="Restore thread" aria-label={`Restore ${tab.label}`}
          onClick={(e) => { e.stopPropagation(); onRestore(); }}
          style={{ width: 16, height: 16, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', borderRadius: 4, flexShrink: 0 }}>
          <ArrowCounterClockwise size={13} weight="bold" />
        </button>
      )}
    </div>
  );
}
