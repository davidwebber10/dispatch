// Overseer view — desktop root (spec §1b). Owns the theme tokens (via .overseer-root
// + overseerRootStyle), composes the shared region components, and swaps to the mobile
// variant at the narrow breakpoint. All data flows through the store / useRenderVals();
// no props are passed to the region components.

import { useIsMobile } from '../../hooks/useIsMobile';
import { overseerRootStyle } from './atoms';
import { OverseerMobile } from './OverseerMobile';
import { useCoordinatorSync, useNeedsSync } from './store';
import './tokens.css';

import { ConversationStream } from './components/Stream';
import { Composer } from './components/Composer';
import { WorkerLightbox } from './components/WorkerLightbox';

export function OverseerView({ onBack }: { onBack?: () => void } = {}) {
  const isMobile = useIsMobile();
  // Single owner of the live coordinator subscription + the membrane escalation sync
  // (both run for desktop and mobile since OverseerView is the entry for both).
  useCoordinatorSync();
  useNeedsSync();

  // Mobile renders inside the MobileApp full-screen overlay, so its consolidated header
  // owns the back affordance (onBack closes the overlay). Desktop opens as a tab and has
  // no back-nav — onBack is simply absent there.
  if (isMobile) return <OverseerMobile onBack={onBack} />;

  return (
    // flex + minWidth: 0 so the root actually claims the width its own flex-row parent
    // (App.tsx) offers, instead of shrink-wrapping to the panel's content size.
    // No header, no card framing — the Dispatch tab renders flush like any other tab
    // (see TabHost's AiThread/ChatView), starting directly with the conversation body.
    <div className="overseer-root" style={{ ...overseerRootStyle, flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'row', background: 'var(--base)' }}>
      {/* LEFT — conversation membrane (the Needs queue now lives in the header alert
          dropdown — see NeedsAlert — so it no longer sits above the stream). */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ConversationStream />
        <Composer />
      </div>

      <WorkerLightbox />
    </div>
  );
}
