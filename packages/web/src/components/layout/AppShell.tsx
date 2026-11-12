import type { ReactNode } from 'react';
import { IconRail } from './IconRail';
import { UsageBanner } from './UsageBanner';
import { lazy, Suspense } from 'react';
// Loaded on demand: a local install never downloads the OS shell.
const OsLeftRail = lazy(() => import('./os/OsLeftRail').then((m) => ({ default: m.OsLeftRail })));
import { usesOsLook } from '../../lib/hostContext';

// A hosted workspace (and the business preview) wears the Polywood OS shell: OsLeftRail in place of the
// icon rail, holding `rail` (the Threads | Projects list). A local install keeps the icon rail.
export function AppShell({ children, rail }: { children: ReactNode; rail?: ReactNode }) {
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--color-base)' }}>
      {usesOsLook() ? <Suspense fallback={<div style={{ width: 288, flexShrink: 0, background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)' }} />}><OsLeftRail sidebar={rail} /></Suspense> : <IconRail />}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Agents paused on a usage limit (#127): a strip above every view, so it is seen from anywhere. */}
        <UsageBanner />
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}>{children}</div>
      </div>
    </div>
  );
}
