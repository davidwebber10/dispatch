import { useState } from 'react';
import { Modal } from '../components/common/Modal';
import { api } from '../api/client';
import { useProjects } from '../stores/projects';
import { fieldInput, solidBtn, ghostBtn, chip, sectionLabel } from '../components/settings/ui';

/** What a plugin hands `d.actions.createSkill` (coach spec section 4.8). */
export interface SkillDraftIn { id?: string; name: string; description?: string; body: string; projects?: string[]; projectId?: string }

/** A lower-case slug the daemon takes (letters, digits, dashes; at most 64). */
export function slugOf(text: string): string {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return s || 'skill';
}

/**
 * The review sheet for a drafted skill: the name, id, description, body and the projects that
 * get it are all editable. Only Create writes (POST /api/skills, which also enables it); Cancel
 * and closing write nothing. An error from the daemon (an id that exists) stays in the sheet.
 */
export function CreateSkillSheet({ draft, onDone }: { draft: SkillDraftIn; onDone: (r: { id: string } | null) => void }) {
  const sessions = useProjects((s) => s.sessions);
  const activeId = useProjects((s) => s.activeId);
  const here = sessions.find((s) => s.id === (draft.projectId ?? activeId)) ?? null;
  const [name, setName] = useState(draft.name);
  const [id, setId] = useState(draft.id ? slugOf(draft.id) : slugOf(draft.name));
  const [idTouched, setIdTouched] = useState(!!draft.id);
  const [description, setDescription] = useState(draft.description ?? '');
  const [body, setBody] = useState(draft.body);
  const [scope, setScope] = useState<'all' | 'here'>(draft.projects && draft.projects.length ? 'here' : 'all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && name.trim().length > 0 && body.trim().length > 0;

  const create = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      const projects = scope === 'here' ? (draft.projects && draft.projects.length ? draft.projects : here ? [here.id] : undefined) : undefined;
      const r = await api.createSkill({ id, name: name.trim(), description: description.trim(), body, ...(projects ? { projects } : {}) });
      onDone({ id: r.skill.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const label = (text: string) => <div style={{ ...sectionLabel, marginTop: 12, marginBottom: 4 }}>{text}</div>;
  return (
    <Modal open onClose={() => onDone(null)} title="Create a skill" maxWidth={620}>
      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
        Every thread gets a skill's text. Review it, then press Create: nothing is written before that.
      </div>
      {label('NAME')}
      <input aria-label="Name" style={fieldInput} value={name} onChange={(e) => { setName(e.target.value); if (!idTouched) setId(slugOf(e.target.value)); }} />
      {label('ID')}
      <input aria-label="Id" style={fieldInput} value={id} onChange={(e) => { setIdTouched(true); setId(e.target.value); }} />
      {label('DESCRIPTION')}
      <input aria-label="Description" style={fieldInput} value={description} onChange={(e) => setDescription(e.target.value)} />
      {label('SKILL.MD')}
      <textarea aria-label="SKILL.md" style={{ ...fieldInput, height: 180, fontFamily: 'var(--font-mono)', fontSize: 12, padding: 8, resize: 'vertical' }} value={body} onChange={(e) => setBody(e.target.value)} />
      {label('WHO GETS IT')}
      <div role="radiogroup" aria-label="Who gets it" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" role="radio" aria-checked={scope === 'all'} style={{ ...chip, ...(scope === 'all' ? { borderColor: 'var(--color-accent)', color: 'var(--color-accent)' } : {}) }} onClick={() => setScope('all')}>All projects</button>
        {here && <button type="button" role="radio" aria-checked={scope === 'here'} style={{ ...chip, ...(scope === 'here' ? { borderColor: 'var(--color-accent)', color: 'var(--color-accent)' } : {}) }} onClick={() => setScope('here')}>Only {here.name}</button>}
      </div>
      {error && <div role="alert" style={{ marginTop: 10, fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button type="button" style={ghostBtn} onClick={() => onDone(null)}>Cancel</button>
        <button type="button" style={solidBtn(valid && !busy)} disabled={!valid || busy} onClick={() => { void create(); }}>{busy ? 'Creating…' : 'Create'}</button>
      </div>
    </Modal>
  );
}
