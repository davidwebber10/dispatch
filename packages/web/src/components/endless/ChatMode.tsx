import { useEffect } from 'react';
import { useEndless } from '../../stores/endless';
import { EndlessColumn } from './EndlessColumn';

/** The Chat page (spec 2026-10-13, section 7). Loads the tail, the turn state and the projects once. */
export function ChatMode({ mobile = false }: { mobile?: boolean }) {
  const unavailable = useEndless((s) => s.unavailable);
  useEffect(() => {
    const s = useEndless.getState();
    void s.loadTail().catch(() => {});
    void s.refreshState().catch(() => {});
    void s.loadProjects().catch(() => {});
  }, []);
  return (
    <div data-testid="chat-mode" data-mobile={mobile ? '1' : undefined}
      style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, height: '100%', background: 'var(--color-base)' }}>
      {unavailable ? (
        <div role="status" style={{ margin: 'auto', color: 'var(--color-text-secondary)', fontSize: 13 }}>
          Chat is unavailable. It may still be starting.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
          <EndlessColumn />
        </div>
      )}
    </div>
  );
}
