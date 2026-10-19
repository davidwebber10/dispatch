import type { EndlessPaneState } from '../../api/types';
export const STATE_WORD: Record<EndlessPaneState, string> = { working: 'working', needs_you: 'needs you', queued: 'queued', error: 'error', done: 'done', idle: 'idle' };
export function StateMark({ state, size = 10 }: { state: EndlessPaneState; size?: number }) {
  const s = size; const c = s / 2;
  const body = (() => {
    switch (state) {
      case 'working': return <><circle cx={c} cy={c} r={c - 0.5} fill="none" stroke="var(--color-accent)" strokeOpacity={0.35} strokeWidth={1} /><circle cx={c} cy={c} r={c * 0.5} fill="var(--color-accent)" /></>;
      case 'needs_you': return <rect x={c * 0.35} y={c * 0.35} width={c * 1.3} height={c * 1.3} transform={`rotate(45 ${c} ${c})`} fill="var(--color-status-yellow)" />;
      case 'queued': return <circle cx={c} cy={c} r={c * 0.6} fill="none" stroke="var(--color-text-tertiary)" strokeWidth={1.5} />;
      case 'error': return <rect x={c * 0.4} y={c * 0.4} width={c * 1.2} height={c * 1.2} fill="var(--color-status-red)" />;
      default: return <path d={`M${s * 0.15} ${s * 0.55} L${s * 0.42} ${s * 0.8} L${s * 0.88} ${s * 0.25}`} fill="none" stroke="var(--color-text-tertiary)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />;
    }
  })();
  return <svg role="img" aria-label={STATE_WORD[state]} width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ flexShrink: 0 }}>{body}</svg>;
}
