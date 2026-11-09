import type { ReactNode } from 'react';
import { CaretLeft } from '@phosphor-icons/react';
import { Marquee } from '../common/Marquee';
import { fontVar } from '../../lib/fontSize';

/**
 * The left half of the phone header on a leaf screen (an open thread, an open plugin screen):
 * a back arrow and the screen's name, which fades at its edge and scrolls when it is long.
 * An optional second line sits under the name (the thread's status dot and account).
 */
export function LeafHeaderTitle({ title, onBack, backLabel, testId, subtitle }: {
  title: string;
  onBack: () => void;
  backLabel: string;
  testId: string;
  subtitle?: ReactNode;
}) {
  return (
    <>
      <button data-leaf-back onClick={onBack} aria-label={backLabel} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '4px 2px', flexShrink: 0 }}>
        <CaretLeft size={22} weight="bold" />
      </button>
      <div data-leaf-title data-testid={testId} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
        <Marquee text={title} style={{ fontWeight: 600, fontSize: fontVar(15.5), color: 'var(--color-text-primary)' }} />
        {subtitle}
      </div>
    </>
  );
}
