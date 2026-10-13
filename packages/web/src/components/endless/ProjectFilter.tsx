import { useEndless } from '../../stores/endless';

const chip = (active: boolean): React.CSSProperties => ({
  flexShrink: 0, padding: '4px 11px', borderRadius: 999, cursor: 'pointer', font: '500 12px var(--font-sans)',
  border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
  background: active ? 'rgba(62,207,106,0.10)' : 'transparent',
  color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
});

/** `All` + one button per project with messages; filters the chat and the search (spec section 7). */
export function ProjectFilter({ mobile = false }: { mobile?: boolean } = {}) {
  const projects = useEndless((s) => s.projects);
  const filter = useEndless((s) => s.filter);
  const shown = projects.filter((p) => p.messages > 0 || p.id === filter);
  if (shown.length === 0) return null;
  const pick = (id: string | null) => void useEndless.getState().setFilter(id).catch(() => {});
  return (
    <div role="toolbar" aria-label="Project filter" style={{ display: 'flex', gap: 6, padding: mobile ? '8px 16px' : '8px 12px', overflowX: 'auto', flexShrink: 0, borderBottom: '1px solid var(--color-border)' }}>
      <button type="button" aria-pressed={filter === null} onClick={() => pick(null)} style={chip(filter === null)}>All</button>
      {shown.map((p) => (
        <button key={p.id} type="button" aria-pressed={filter === p.id} onClick={() => pick(p.id)} style={chip(filter === p.id)}>{p.name}</button>
      ))}
    </div>
  );
}
