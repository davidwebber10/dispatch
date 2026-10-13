import { ArrowClockwise } from '@phosphor-icons/react';
import { useEndless } from '../../stores/endless';

/** Per project: live threads, threads that need you, open items, and the last report (spec section 7). */
export function ProjectsPanel() {
  const projects = useEndless((s) => s.projects);
  const unavailable = useEndless((s) => s.unavailable);
  const shown = projects.filter((p) => p.live + p.needsYou + p.openItems > 0 || p.messages > 0 || p.lastReport);
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ font: '600 12px var(--font-sans)', letterSpacing: '0.04em', color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>Projects</span>
        <button type="button" aria-label="Refresh projects" onClick={() => void useEndless.getState().loadProjects().catch(() => {})}
          style={{ width: 28, height: 28, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
          <ArrowClockwise size={14} />
        </button>
      </div>
      {shown.length === 0 && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>{unavailable ? 'Projects are unavailable.' : 'No project activity yet.'}</div>}
      {shown.map((p) => (
        <div key={p.id} data-testid={`project-${p.id}`} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-text-primary)' }}>{p.name}</div>
          <div style={{ font: '400 12px var(--font-mono)', color: p.needsYou > 0 ? 'var(--color-status-yellow)' : 'var(--color-text-tertiary)' }}>
            {p.live} live · {p.needsYou} need you · {p.openItems} open
          </div>
          {p.lastReport && (
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.lastReport}</div>
          )}
        </div>
      ))}
    </div>
  );
}
