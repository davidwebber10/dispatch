import { Eye, TerminalWindow } from '@phosphor-icons/react';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useThreadMode, type ThreadMode } from '../../stores/threadMode';

/**
 * View/Terminal toggle (icons) for an AI thread. Two looks:
 *  - default: a compact inline pill (used in the mobile header).
 *  - floating: bigger, semi-transparent, glassy — meant to be absolutely
 *    positioned over the top-right of the terminal/view content on desktop.
 * Renders nothing unless `terminalId` is a live claude-code/codex thread.
 */
export function ModeToggle({ terminalId, floating = false }: { terminalId: string | null | undefined; floating?: boolean }) {
  const tab = useTabs((s) => (terminalId ? findTerminal(s.byProject, terminalId) : undefined));
  const mode = useThreadMode((s) => (terminalId ? s.modes[terminalId] : undefined)) ?? 'expert';
  const setMode = useThreadMode((s) => s.set);
  if (!terminalId || !tab || (tab.type !== 'claude-code' && tab.type !== 'codex')) return null;
  const opts: [ThreadMode, typeof Eye, string][] = [['normal', Eye, 'View'], ['expert', TerminalWindow, 'Terminal']];
  const dim = floating ? { w: 46, h: 32, icon: 19, radius: 9, pad: 3 } : { w: 36, h: 24, icon: 15, radius: 6, pad: 2 };
  return (
    <div style={{
      display: 'flex', gap: 2, padding: dim.pad,
      borderRadius: floating ? 11 : 8,
      background: floating ? 'rgba(22,22,26,0.55)' : 'var(--color-elevated)',
      border: floating ? '1px solid rgba(255,255,255,0.10)' : '1px solid #2C2C32',
      ...(floating ? { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', boxShadow: '0 6px 18px -8px rgba(0,0,0,.6)' } : {}),
    }}>
      {opts.map(([m, Icon, label]) => (
        <button key={m} title={label} onClick={() => setMode(terminalId, m)} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: dim.w, height: dim.h, borderRadius: dim.radius, border: 'none', cursor: 'pointer',
          background: mode === m ? (floating ? 'rgba(255,255,255,0.14)' : 'var(--color-hover)') : 'transparent',
          color: mode === m ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
          transition: 'background .12s ease, color .12s ease',
        }}>
          <Icon size={dim.icon} weight={mode === m ? 'fill' : 'regular'} />
        </button>
      ))}
    </div>
  );
}
