import { useProjects } from '../../stores/projects';

/** The composer's project tag. "General" sends with no project. */
export function ProjectSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const sessions = useProjects((s) => s.sessions);
  return (
    <select aria-label="Project" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}
      style={{ alignSelf: 'flex-start', maxWidth: 220, height: 28, padding: '0 8px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', fontSize: 13 }}>
      <option value="">General</option>
      {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}
