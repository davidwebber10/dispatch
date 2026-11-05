import type { ReactNode } from 'react';
import { IconRail } from './IconRail';
import { UsageBanner } from './UsageBanner';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--color-base)' }}>
      <IconRail />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Agents paused on a usage limit (#127): a strip above every view, so it is seen from anywhere. */}
        <UsageBanner />
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}>{children}</div>
      </div>
    </div>
  );
}
