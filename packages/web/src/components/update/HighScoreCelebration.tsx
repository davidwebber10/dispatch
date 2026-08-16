import { useState } from 'react';
import { Trophy } from '@phosphor-icons/react';
import { Fireworks } from './Fireworks';
import { readAndClearCelebration } from './popScore';

/**
 * The post-restart payoff for the update-rain pop game: when the just-finished
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
      style={{ position: 'fixed', inset: 0, zIndex: 290, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))' }}
    >
      <Fireworks />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 340,
          maxWidth: '100%',
          background: 'rgba(27,27,30,.55)',
          backdropFilter: 'blur(10px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(10px) saturate(1.4)',
          border: '1px solid rgba(255,255,255,.14)',
          borderRadius: 16,
          padding: '24px 20px',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)',
          textAlign: 'center',
        }}
      >
        <Trophy size={34} weight="fill" color="#F5C542" />
        <div style={{ marginTop: 8, fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)' }}>New high score!</div>
        <div style={{ marginTop: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 40, fontWeight: 700, lineHeight: 1, color: 'rgba(140,255,180,1)', textShadow: '0 0 16px rgba(62,207,106,.55)' }}>
          {celebration.score}
        </div>
        <div style={{ marginTop: 4, fontSize: 11, letterSpacing: 2, color: 'rgba(62,207,106,.75)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>POPS</div>
        <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
          {celebration.prev > 0
            ? <>You beat your old best of {celebration.prev} during the update.</>
            : <>Your first update-rain high score. It's on the board now.</>}
        </div>
        <div style={{ marginTop: 18 }}>
          <button
            onClick={close}
            style={{ height: 38, padding: '0 22px', background: 'var(--color-accent)', border: 'none', borderRadius: 10, color: '#08240F', fontWeight: 600, fontSize: 13.5, cursor: 'pointer' }}
          >
            Nice
          </button>
        </div>
      </div>
    </div>
  );
}
