import { useEffect, useState } from 'react';
import { ShieldCheck } from '@phosphor-icons/react';
import { api } from '../../../api/client';
import { useTabs, findTerminal } from '../../../stores/tabs';
import { can } from '../../../lib/profile';

type Mode = 'auto' | 'ask' | 'smart';
const LABEL: Record<Mode, string> = { auto: 'Auto', ask: 'Ask', smart: 'Smart' };
const HINT: Record<Mode, string> = {
  auto: 'Every tool runs without asking',
  ask: 'Every gated tool waits for you',
  smart: 'Routine work runs; risky actions ask or are blocked',
};

/**
 * The approvals setting of one chat thread (core os/approvals-routes.ts): Auto, Ask or Smart. Developer
 * profile only (lib/profile.ts 'approvals.choose'): a business person's threads are always Smart, and the
 * daemon refuses any other value for them. A coordinator keeps its own rules, so it gets no control.
 * The change is saved and applied to a running thread when the harness can; else at its next start.
 */
export function ApprovalsControl({ terminalId, floating = false }: { terminalId: string; floating?: boolean }) {
  const tab = useTabs((s) => findTerminal(s.byProject, terminalId));
  const [mode, setMode] = useState<Mode | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const role = (tab?.config as { role?: string } | undefined)?.role;
  const chat = !!tab && (tab.type === 'claude-code' || tab.type === 'codex' || tab.type === 'grok' || tab.type === 'opencode')
    && (tab.config as { transport?: string } | undefined)?.transport === 'structured' && role !== 'coordinator';
  useEffect(() => {
    if (!chat) return;
    let live = true;
    setMode(null); setNote(null);
    api.getApprovals(terminalId).then((a) => { if (live && a && (a.mode === 'auto' || a.mode === 'ask' || a.mode === 'smart')) setMode(a.mode); }).catch(() => {});
    return () => { live = false; };
  }, [terminalId, chat]);
  if (!can('approvals.choose') || !chat || !mode) return null;
  const pick = async (next: Mode) => {
    if (next === mode) return;
    const prev = mode;
    setMode(next); setNote(null);
    try {
      const r = await api.setApprovals(terminalId, next);
      setNote(r.live ? null : 'Applies at the next start');
    } catch (e) {
      setMode(prev);
      setNote(e instanceof Error ? e.message : 'Could not change approvals');
    }
  };
  return (
    <div role="group" aria-label="Approvals" title={note ?? `Approvals: ${HINT[mode]}`} style={{
      display: 'flex', alignItems: 'center', gap: 2, padding: 3, height: floating ? 38 : 32, boxSizing: 'border-box',
      borderRadius: 'var(--radius-lg)', background: 'color-mix(in srgb, var(--color-pane) 55%, transparent)',
      border: '1px solid color-mix(in srgb, var(--color-text-emphasis) 10%, transparent)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    }}>
      <ShieldCheck size={15} style={{ margin: '0 4px 0 6px', color: 'var(--color-text-secondary)', flexShrink: 0 }} aria-hidden />
      {(['auto', 'ask', 'smart'] as const).map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} title={HINT[m]} onClick={() => void pick(m)} style={{
          height: '100%', padding: '0 9px', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', font: '500 12px var(--font-sans)',
          background: mode === m ? 'color-mix(in srgb, var(--color-text-emphasis) 14%, transparent)' : 'transparent',
          color: mode === m ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        }}>{LABEL[m]}</button>
      ))}
    </div>
  );
}
