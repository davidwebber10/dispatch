import { useEffect, useState } from 'react';
import { GraduationCap } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { SkillRow } from '../../api/types';
import { useProjects } from '../../stores/projects';
import { ConfirmModal } from '../common/ConfirmModal';
import { Select } from '../common/Select';
import { SettingsPage, SettingsGroup, SettingsRow, SettingsSubPage, SettingsDisclosure, EmptyState, StatusMark, Toggle, codeChip } from './ui';
import { useSectionSubPage } from './useSectionSubPage';

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11.5 };

/**
 * Settings → Skills (docs/superpowers/specs/2026-11-07-plugins-design.md, section 8): every skill
 * under ~/.dispatch/skills (local, or installed from a marketplace on the Plugins page), on or off
 * everywhere, and on or off for one project. The enabled skills' texts go into each thread's
 * prompt under their names with the folder path.
 *
 * 2026-11-07 (docs/design/settings-layout.md): the project filter is a row at the top; the skills are
 * one group of list rows (a switch for the place the filter names, a chevron to the skill's page);
 * the text, both switches, the folder and Remove (behind a confirm) live on that page.
 */
export function SkillsSection() {
  const sessions = useProjects((s) => s.sessions);
  const [project, setProject] = useState('');
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [err, setErr] = useState('');
  const [removing, setRemoving] = useState<SkillRow | null>(null);
  const page = useSectionSubPage('skills');
  const load = async (p = project) => {
    try { setSkills((await api.listSkills(p || undefined)).skills); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(project); }, [project]);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const projectName = sessions.find((s) => s.id === project)?.name ?? '';

  const flipEverywhere = (s: SkillRow) => void run(() => (s.enabled ? api.disableSkill(s.id) : api.enableSkill(s.id)));
  const flipHere = (s: SkillRow) => void run(() => (s.enabledHere ? api.disableSkill(s.id, project) : api.enableSkill(s.id, project)));
  const remove = (s: SkillRow) => { setRemoving(null); page.close(); void run(() => api.removeSkill(s.id)); };

  const errLine = err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{err}</div>;
  const confirm = (
    <ConfirmModal open={removing !== null} danger title={`Remove ${removing?.name ?? 'this skill'}?`} confirmLabel="Remove skill"
      message="Dispatch deletes its folder under ~/.dispatch/skills, so no new thread gets its text. A skill from a marketplace can be installed again from Plugins."
      onCancel={() => setRemoving(null)} onConfirm={() => { if (removing) remove(removing); }} />
  );

  const opened = page.openId ? skills?.find((s) => s.id === page.openId) : undefined;
  if (opened) {
    const s = opened;
    const source = s.install ? 'Installed' : 'Local';
    const only = s.harnesses ? ` · ${s.harnesses.join(', ')} only` : '';
    return (
      <div data-subpage-top>
        <SettingsSubPage testId={`skill-page-${s.id}`} icon={GraduationCap} title={s.name} subtitle={`v${s.version} · ${source}${only}`} description={s.description ?? undefined}
          backLabel="Skills" onBack={page.backLink ? page.close : undefined}>
          {s.error && <StatusMark tone="red">{s.error}</StatusMark>}
          {errLine}
          <SettingsGroup title="Where it is on">
            <SettingsRow label="Enabled everywhere" hint="Every thread gets this skill." control={<Toggle on={s.enabled} label="Enabled everywhere" onClick={() => flipEverywhere(s)} />} />
            {project && <SettingsRow label={`Enabled for ${projectName}`} hint="Only this project's threads." control={<Toggle on={s.enabledHere === true} label={`Enabled for ${projectName}`} onClick={() => flipHere(s)} />} />}
          </SettingsGroup>
          <SettingsGroup title="Text" footer="Threads get this text under the skill's name, with the folder's path so the model can read the rest.">
            <pre data-testid="skill-text" style={{ margin: 0, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '12px/1.55 var(--font-mono)', color: 'var(--color-text-secondary)', padding: '11px 12px' }}>{s.text}</pre>
          </SettingsGroup>
          <SettingsDisclosure label="Developer" hint="The folder and where it came from.">
            <SettingsRow label="Folder" hint={<span style={{ ...mono, overflowWrap: 'anywhere' }}>{s.folder}</span>} />
            {s.install && <SettingsRow label="Installed from" hint={<span style={{ ...mono, overflowWrap: 'anywhere' }}>{s.install.marketplace}</span>} />}
          </SettingsDisclosure>
          <SettingsGroup>
            <SettingsRow label="Remove skill" ariaLabel="Remove skill" danger onClick={() => setRemoving(s)} />
          </SettingsGroup>
        </SettingsSubPage>
        {confirm}
      </div>
    );
  }

  return (
    <SettingsPage intro={<>Skills are short texts every thread gets. Install them from a marketplace on the Plugins page, or add a folder under <span style={codeChip}>~/.dispatch/skills</span>.</>}>
      <SettingsGroup>
        <SettingsRow label="Project" hint={project ? `The switches turn a skill on or off for ${projectName}.` : 'The switches apply everywhere. Pick a project to set its own.'}
          control={<Select ariaLabel="Project" value={project} onChange={setProject} style={{ width: 160 }}
            options={[{ value: '', label: 'Everywhere' }, ...sessions.map((s) => ({ value: s.id, label: s.name }))]} />} />
      </SettingsGroup>
      {errLine}
      {skills && skills.length === 0 && (
        <EmptyState>No skills yet. Add a marketplace on the Plugins page and install one, or write a folder under ~/.dispatch/skills.</EmptyState>
      )}
      {skills && skills.length > 0 && (
        <SettingsGroup title="Skills">
          {skills.map((s) => {
            const on = project ? s.enabledHere === true : s.enabled;
            const label = project ? `Enabled for ${projectName}` : 'Enabled everywhere';
            return (
              <div key={s.id} data-testid={`skill-row-${s.id}`}>
                <SettingsRow icon={GraduationCap} label={s.name} ariaLabel={`${s.name}: open`}
                  hint={s.error ? <StatusMark tone="red">{s.error}</StatusMark> : <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description || (s.install ? 'Installed from a marketplace' : 'Local skill')}</span>}
                  control={<Toggle on={on} label={label} onClick={() => (project ? flipHere(s) : flipEverywhere(s))} />}
                  onClick={() => page.open(s.id)} />
              </div>
            );
          })}
        </SettingsGroup>
      )}
      {confirm}
    </SettingsPage>
  );
}
