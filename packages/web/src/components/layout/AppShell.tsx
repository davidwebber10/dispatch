import type { ReactNode } from 'react';
import { IconRail } from './IconRail';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--color-base)' }}>
      <IconRail />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}>{children}</div>
    </div>
  );
}
