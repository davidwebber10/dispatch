import { useEffect, useMemo } from 'react';
import { usePreviews } from '../../stores/previews';
import { PreviewItem } from './PreviewItem';

/**
 * The desktop rail's Previews view: the full history across projects, newest first, grouped
 * by day, each with its project, thread and time. Opening it marks everything seen.
 */
export function PreviewsView() {
  const items = usePreviews((s) => s.items);
  const loaded = usePreviews((s) => s.loaded);
  useEffect(() => {
    void usePreviews.getState().load();
    void usePreviews.getState().markAllSeen();
  }, []);
  // A preview that arrives while the view is open is marked seen too: the user is looking at it.
  useEffect(() => {
    if (items.some((p) => !p.seenAt)) void usePreviews.getState().markAllSeen();
  }, [items]);
  const groups = useMemo(() => {
    const out: { day: string; items: typeof items }[] = [];
    for (const p of items) {
      const d = new Date(p.createdAt);
      const day = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      const g = out[out.length - 1];
      if (g && g.day === day) g.items.push(p); else out.push({ day, items: [p] });
    }
    return out;
  }, [items]);
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 26px 40px' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Previews</h1>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 }}>Files and text that threads handed you to look at or copy, newest first.</div>
        </div>
        {items.length === 0 && (
          <div style={{ fontSize: 13.5, color: 'var(--color-text-tertiary)', padding: '20px 0' }}>
            {loaded ? 'Nothing yet. Ask a thread to show you a screenshot, a page, or a string with its preview tool.' : 'Loading…'}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.day} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2 style={{ margin: 0, font: '500 10.5px var(--font-mono)', letterSpacing: '1.2px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>{g.day}</h2>
            {g.items.map((p) => <PreviewItem key={p.id} preview={p} onDelete={(id) => void usePreviews.getState().remove(id)} />)}
          </section>
        ))}
      </div>
    </div>
  );
}
