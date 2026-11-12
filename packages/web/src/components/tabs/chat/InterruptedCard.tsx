import { useState } from 'react';
import { ArrowClockwise } from '@phosphor-icons/react';
import { api } from '../../../api/client';
import type { Terminal } from '../../../api/types';
import { Button } from '../../ui';

/**
 * "This thread was interrupted": a Grok or OpenCode chat that a restart stopped mid-turn. These
 * harnesses cannot resume a turn by themselves (Claude and Codex continue on their own after a
 * restart), so the person presses Continue. The stamp is `config.interruptedAt` (core os/continuity.ts).
 */
export function InterruptedCard({ tab }: { tab: Terminal }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const cfg = (tab.config ?? {}) as Record<string, unknown>;
  if (state === 'done' || typeof cfg.interruptedAt !== 'string') return null;
  if (tab.type !== 'grok' && tab.type !== 'opencode') return null;
  const go = async () => {
    setState('busy'); setError(null);
    try { await api.continueThread(tab.id); setState('done'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setState('idle'); }
  };
  return (
    <div data-testid="interrupted-card" style={{ flexShrink: 0, maxWidth: 768, width: 'calc(100% - 28px)', boxSizing: 'border-box', margin: '10px auto 0', padding: '12px 14px', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ flex: 1, minWidth: 180, fontSize: 13, color: 'var(--color-text-body)' }}>This thread was interrupted by a restart. Press Continue to carry on.</span>
      <Button variant="primary" size="sm" icon={<ArrowClockwise size={13} />} disabled={state === 'busy'} onClick={() => void go()}>Continue</Button>
      {error && <span role="alert" style={{ width: '100%', fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</span>}
    </div>
  );
}
