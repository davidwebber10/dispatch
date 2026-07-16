import { useState } from 'react';
import { Bell } from '@phosphor-icons/react';
import { useTabs, findTerminal } from '../../stores/tabs';
import { canReceiveAlerts, ensurePushEnrolled } from '../../lib/push';

/**
 * Per-thread alert (bell) toggle for an AI thread's header. Two looks, mirroring
 * ModeToggle: compact inline pill (mobile header) and floating glassy (desktop,
 * over the terminal's top-right). Renders nothing for non-agent threads or in a
 * context that can't receive web push — per design, incapable contexts show no
 * alert UI at all. Enabling from an un-enrolled device runs enrollment inline.
 */
export function AlertBell({ terminalId, floating = false }: { terminalId: string | null | undefined; floating?: boolean }) {
  const tab = useTabs((s) => (terminalId ? findTerminal(s.byProject, terminalId) : undefined));
  const [busy, setBusy] = useState(false);
  if (!terminalId || !tab || (tab.type !== 'claude-code' && tab.type !== 'codex')) return null;
  if (!canReceiveAlerts()) return null;
  const on = !!(tab.config as { alertsEnabled?: boolean })?.alertsEnabled;
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!on) { const err = await ensurePushEnrolled(); if (err) { window.alert(err); return; } }
      await useTabs.getState().setAlertsEnabled(terminalId, !on);
    } finally { setBusy(false); }
  };
  const dim = floating ? { w: 46, h: 32, icon: 19, radius: 9, pad: 3 } : { w: 36, h: 24, icon: 15, radius: 6, pad: 2 };
  return (
    <div style={{
      display: 'flex', padding: dim.pad,
      borderRadius: floating ? 11 : 8,
      background: floating ? 'rgba(22,22,26,0.55)' : 'var(--color-elevated)',
      border: floating ? '1px solid rgba(255,255,255,0.10)' : '1px solid #2C2C32',
      ...(floating ? { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', boxShadow: '0 6px 18px -8px rgba(0,0,0,.6)' } : {}),
    }}>
      <button title={on ? 'Alerts on — click to disable' : 'Alerts off — click to enable'} onClick={() => void toggle()} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: dim.w, height: dim.h, borderRadius: dim.radius, border: 'none', cursor: 'pointer',
        background: on ? (floating ? 'rgba(255,255,255,0.14)' : 'var(--color-hover)') : 'transparent',
        color: on ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        transition: 'background .12s ease, color .12s ease',
      }}>
        <Bell size={dim.icon} weight={on ? 'fill' : 'regular'} />
      </button>
    </div>
  );
}
