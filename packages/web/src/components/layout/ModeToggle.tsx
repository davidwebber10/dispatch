import { Eye, TerminalWindow } from '@phosphor-icons/react';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useThreadMode, type ThreadMode } from '../../stores/threadMode';

/**
 * Centered View/Terminal toggle (icons) for an AI thread, designed to sit in a
 * `position: relative` header. Renders nothing unless `terminalId` is a live
 * claude-code/codex thread.
 */
export function ModeToggle({ terminalId }: { terminalId: string | null | undefined }) {
  const tab = useTabs((s) => (terminalId ? findTerminal(s.byProject, terminalId) : undefined));
  const mode = useThreadMode((s) => (terminalId ? s.modes[terminalId] : undefined)) ?? 'expert';
  const setMode = useThreadMode((s) => s.set);
  if (!terminalId || !tab || (tab.type !== 'claude-code' && tab.type !== 'codex')) return null;
  const opts: [ThreadMode, typeof Eye, string][] = [['normal', Eye, 'View'], ['expert', TerminalWindow, 'Terminal']];
  return (
    <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', display: 'flex', gap: 2, background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: 2, zIndex: 1 }}>
      {opts.map(([m, Icon, label]) => (
        <button key={m} title={label} onClick={() => setMode(terminalId, m)} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 26, borderRadius: 6, border: 'none', cursor: 'pointer',
          background: mode === m ? 'var(--color-hover)' : 'transparent',
          color: mode === m ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        }}>
          <Icon size={16} weight={mode === m ? 'fill' : 'regular'} />
        </button>
      ))}
    </div>
  );
}
