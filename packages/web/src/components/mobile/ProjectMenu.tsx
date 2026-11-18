import { useState } from 'react';
import { PencilSimple, Archive } from '@phosphor-icons/react';
import type { Session } from '../../api/types';
import { Modal } from '../common/Modal';
import { ConfirmModal } from '../common/ConfirmModal';
import { RenameProjectModal } from '../sidebar/RenameProjectModal';
import { useProjects } from '../../stores/projects';
import { useContributions } from '../../plugins/registry';
import { fontVar } from '../../lib/fontSize';

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '13px 12px', background: 'transparent', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: fontVar(15), font: 'inherit' };

/**
 * The phone's project ⋯ menu (2026-11-06): the project screen's header matches the thread
 * screen's, so its options live behind one ⋯ button too. Previews first (the header button it
 * replaces), then the project's own actions, the same two the desktop right-click offers.
 */
export function ProjectMenu({ project, open, onClose, onArchived }: { project: Session; open: boolean; onClose: () => void; onArchived: () => void }) {
  const [renaming, setRenaming] = useState(false);
  // Items plugins added (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.3).
  const pluginItems = useContributions('projectMenu');
  const [archiving, setArchiving] = useState(false);
  const archive = async () => {
    setArchiving(false);
    try { await useProjects.getState().archive(project.id); onArchived(); } catch { /* surfaced via connection state */ }
  };
  return (
    <>
      <Modal open={open} sheet title={project.name} onClose={onClose}>
        <div role="menu" style={{ display: 'flex', flexDirection: 'column', paddingBottom: 4 }}>
          {pluginItems.filter((p) => !p.when || p.when({ session: project })).map((p) => (
            <button key={`${p.plugin}:${p.id}`} type="button" style={row} onClick={() => { onClose(); p.onPick({ session: project }); }}>{p.label}</button>
          ))}
          <div aria-hidden style={{ height: 1, background: 'var(--color-border)', margin: '4px 6px' }} />
          <button type="button" style={row} onClick={() => { onClose(); setRenaming(true); }}><PencilSimple size={17} />Rename project</button>
          <button type="button" style={{ ...row, color: 'var(--color-status-red)' }} onClick={() => { onClose(); setArchiving(true); }}><Archive size={17} />Archive project</button>
        </div>
      </Modal>
      <ConfirmModal
        open={archiving}
        title="Archive project?"
        message={`“${project.name}” and its threads will be archived. You can restore it later.`}
        confirmLabel="Archive"
        danger
        onConfirm={() => void archive()}
        onCancel={() => setArchiving(false)}
      />
      {renaming && <RenameProjectModal sessionId={project.id} current={project.name} onClose={() => setRenaming(false)} />}
    </>
  );
}
