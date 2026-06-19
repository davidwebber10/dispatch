import type { ReactNode } from 'react';
import { TopBar } from './TopBar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-base)' }}>
      <TopBar />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>{children}</div>
    </div>
  );
}
