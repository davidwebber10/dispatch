import { useState } from 'react';
import { Trophy } from '@phosphor-icons/react';
import { Fireworks } from './Fireworks';
import { readAndClearCelebration } from './popScore';
import { fontVar } from '../../lib/fontSize';

/**
 * The post-restart payoff for the update game (the blaster): when the just-finished
 * round set a new high score, the updating page leaves a one-shot celebration
 * flag in localStorage (see popScore.ts — state can't survive the hard reload
 * any other way). This component, mounted in the NORMAL app view next to
 * UpdateModal, claims that flag on mount and throws the party: fireworks
 * behind a glass score card. Renders null for everyone else, every other load.
 *
 * The lazy useState initializer is what makes the flag one-shot — it reads AND
 * clears in a single pass on first render, so a re-render, a second mount
 * (mobile/desktop shells), or a manual refresh can't celebrate twice.
 */
export function HighScoreCelebration() {
  const [celebration] = useState(readAndClearCelebration);
  const [open, setOpen] = useState(true);

  if (!celebration || !open) return null;
  const close = () => setOpen(false);

  return (
    <div
      onClick={close}
      style={{ position: 'fixed', inset: 0, zIndex: 290, background: 'var(--color-overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))' }}
    >
      <Fireworks />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 340,
          maxWidth: '100%',
          background: 'color-mix(in srgb, var(--color-pane) 55%, transparent)',
          backdropFilter: 'blur(10px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(10px) saturate(1.4)',
          border: '1px solid color-mix(in srgb, var(--color-text-emphasis) 14%, transparent)',
          borderRadius: 'var(--radius-xl)',
          padding: '24px 20px',
          boxShadow: '0 30px 80px -20px var(--color-shadow-strong)',
          textAlign: 'center',
        }}
      >
        <Trophy size={34} weight="fill" color="var(--color-status-yellow)" />
        <div style={{ marginTop: 8, fontWeight: 600, fontSize: fontVar(16), color: 'var(--color-text-primary)' }}>New high score!</div>
        <div style={{ marginTop: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: fontVar(40), fontWeight: 700, lineHeight: 1, color: 'color-mix(in srgb, var(--color-accent) 60%, var(--color-text-emphasis))', textShadow: '0 0 16px color-mix(in srgb, var(--color-accent) 55%, transparent)' }}>
          {celebration.score}
        </div>
        <div style={{ marginTop: 4, fontSize: fontVar(11), letterSpacing: 2, color: 'color-mix(in srgb, var(--color-accent) 75%, transparent)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>POINTS</div>
        <div style={{ marginTop: 10, fontSize: fontVar(12.5), lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
          {celebration.prev > 0
            ? <>You beat your old best of {celebration.prev} during the update.</>
            : <>Your first blaster high score. It's on the board now.</>}
        </div>
        <div style={{ marginTop: 18 }}>
          <button
            onClick={close}
            style={{ height: 38, padding: '0 22px', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-on-accent)', fontWeight: 600, fontSize: fontVar(13.5), cursor: 'pointer' }}
          >
            Nice
          </button>
        </div>
      </div>
    </div>
  );
}
