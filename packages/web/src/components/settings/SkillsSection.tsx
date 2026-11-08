import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { SkillRow } from '../../api/types';
import { useProjects } from '../../stores/projects';
import { sectionLabel, row, item, ghostBtn, fieldInput, Toggle } from './ui';
import { Select } from '../common/Select';

const note: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-text-tertiary)' };

/**
 * Settings → Skills (docs/superpowers/specs/2026-11-07-plugins-design.md, section 8): every skill
 * under ~/.dispatch/skills (local, or installed from a marketplace on the Plugins page), on or off
 * everywhere, and on or off for one project. The enabled skills' texts go into each thread's
 * prompt under their names with the folder path.
 */
export function SkillsSection() {
  const sessions = useProjects((s) => s.sessions);
  const [project, setProject] = useState('');
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const load = async (p = project) => {
    try { setSkills((await api.listSkills(p || undefined)).skills); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(project); }, [project]);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const projectName = sessions.find((s) => s.id === project)?.name ?? '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section aria-label="Skills" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>SKILLS</span>
        <div style={note}>A folder under ~/.dispatch/skills with a skill.json and a SKILL.md is a skill; the Plugins page installs them from marketplaces. Enabled skills reach every thread's prompt under their name, with the folder's path so the model can read the rest.</div>
        <div style={{ ...row, gap: 10 }}>
          <span style={item}>Project</span>
          <Select ariaLabel="Project" value={project} onChange={setProject} style={{ width: 220 }}
            options={[{ value: '', label: 'Everywhere' }, ...sessions.map((s) => ({ value: s.id, label: s.name }))]} />
        </div>
        {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{err}</div>}
        {skills && skills.length === 0 && <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>No skills yet. Add a marketplace on the Plugins page and install one, or write a folder under ~/.dispatch/skills.</div>}
        {(skills ?? []).map((s) => (
          <div key={s.id} data-testid={`skill-row-${s.id}`} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{s.name}</span>
              <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>v{s.version}</span>
              <span style={{ font: '500 10px var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px' }}>{s.install ? 'Installed' : 'Local'}</span>
              {s.harnesses && <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{s.harnesses.join(', ')} only</span>}
              {s.error && <span style={{ fontSize: 12, color: 'var(--color-status-red)' }}>{s.error}</span>}
            </div>
            {s.description && <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{s.description}</div>}
            <div style={row}>
              <span style={item}>Enabled everywhere</span>
              <Toggle on={s.enabled} label="Enabled everywhere" onClick={() => void run(() => (s.enabled ? api.disableSkill(s.id) : api.enableSkill(s.id)))} />
            </div>
            {project && (
              <div style={row}>
                <span style={item}>Enabled for {projectName}</span>
                <Toggle on={s.enabledHere === true} label={`Enabled for ${projectName}`} onClick={() => void run(() => (s.enabledHere ? api.disableSkill(s.id, project) : api.enableSkill(s.id, project)))} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" style={ghostBtn} onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? 'Hide text' : 'Show text'}</button>
              <button type="button" style={{ ...ghostBtn, color: 'var(--color-status-red)' }} onClick={() => void run(() => api.removeSkill(s.id))}>Remove</button>
            </div>
            {open === s.id && <pre style={{ margin: 0, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '12px/1.5 var(--font-mono)', color: 'var(--color-text-secondary)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>{s.text}</pre>}
          </div>
        ))}
      </section>
    </div>
  );
}
