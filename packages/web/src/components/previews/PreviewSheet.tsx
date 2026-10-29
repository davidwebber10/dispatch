import { useEffect } from 'react';
import { Sheet } from '../settings/ui';
import { usePreviews } from '../../stores/previews';
import { useProjects } from '../../stores/projects';
import { PreviewItem } from './PreviewItem';

/**
 * The project's previews in a bottom sheet (the phone's Previews key next to esc, and the
 * thread header's Previews button; desktop can open it too). Everything shown is marked seen.
 */
export function PreviewSheet() {
  const sessionId = usePreviews((s) => s.sheet);
  const items = usePreviews((s) => s.items);
  const loaded = usePreviews((s) => s.loaded);
  const projectName = useProjects((s) => s.sessions.find((x) => x.id === sessionId)?.name ?? null);
  useEffect(() => {
    if (!sessionId) return;
    void usePreviews.getState().load();
    void usePreviews.getState().markAllSeen(sessionId);
  }, [sessionId]);
  if (!sessionId) return null;
  const mine = items.filter((p) => p.sessionId === sessionId);
  return (
    <Sheet open onClose={() => usePreviews.getState().closeSheet()} title={projectName ? `PREVIEWS · ${projectName.toUpperCase()}` : 'PREVIEWS'}>
      {mine.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', padding: '8px 0 14px' }}>
          {loaded ? 'Nothing here yet. A thread can hand you files and text with its preview tool.' : 'Loading…'}
        </div>
      )}
      {mine.map((p) => <PreviewItem key={p.id} preview={p} showProject={false} onDelete={(id) => void usePreviews.getState().remove(id)} />)}
    </Sheet>
  );
}

/** The small count badge on a Previews control. */
export function PreviewBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span aria-label={`${count} new previews`} style={{ position: 'absolute', top: -5, right: -5, minWidth: 17, height: 17, padding: '0 5px', borderRadius: 9, background: 'var(--color-accent)', color: '#08240F', font: '700 10.5px var(--font-sans)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {count > 99 ? '99+' : count}
    </span>
  );
}
