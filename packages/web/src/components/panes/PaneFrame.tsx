import { DotsSixVertical, X } from '@phosphor-icons/react';
import { useTabs, findTerminal } from '../../stores/tabs';
import { TabHost } from '../tabs/TabHost';

/** One pane inside a grouped view: a 30px title bar (label + grip + close) over
 *  the tab's content (<TabHost/>). The grip's pointerdown fires onMoveStart so a
 *  parent can run the reorganize-drag; the X fires onClose. */
export function PaneFrame({ tabId, onClose, onMoveStart }: {
  tabId: string;
  onClose: () => void;
  /** Called on grip pointerdown — the pointer event is forwarded for drag tracking. */
  onMoveStart?: (e: React.PointerEvent) => void;
}) {
  const byProject = useTabs((s) => s.byProject);
  const label = findTerminal(byProject, tabId)?.label ?? 'tab';

  const iconBtn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, flexShrink: 0, padding: 0,
    background: 'none', border: 'none', borderRadius: 4,
    color: 'var(--color-text-tertiary)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, height: 30, flexShrink: 0,
          padding: '0 6px 0 3px', background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)',
        }}
      >
        <button
          onPointerDown={(e) => { e.preventDefault(); onMoveStart?.(e); }}
          title="Move pane"
          style={{ ...iconBtn, cursor: 'grab', touchAction: 'none' }}
        >
          <DotsSixVertical size={15} weight="bold" />
        </button>
        <span
          style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {label}
        </span>
        <button onClick={onClose} title="Close pane" style={{ ...iconBtn, cursor: 'pointer' }}>
          <X size={13} weight="bold" />
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <TabHost terminalId={tabId} />
      </div>
    </div>
  );
}
