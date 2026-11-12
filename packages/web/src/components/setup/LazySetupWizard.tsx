import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useSetup } from '../../stores/setup';
import { can } from '../../lib/profile';
import type { ProviderStatus } from '../../api/types';
import { ConnectAccountPrompt } from './ConnectAccountPrompt';

// The setup wizard shows on a first run, or when About > "Run setup again" asks for it. Its code
// (with the Secrets section it embeds) is not in the first load (engineering program 2026-11-09,
// W2-E). This gate makes the one setup-state request that the wizard made at each launch, and
// loads the wizard only when it has something to show.
//
// A business person (lib/profile.ts: no 'setup', no 'threads.cli') gets no wizard: they land on the
// workspace, and when Claude is not signed in, ONE prompt "Connect your Claude account" instead.
const Impl = lazy(() => import('./SetupWizard').then((m) => ({ default: m.SetupWizard })));

export function SetupWizard() {
  const forceOpen = useSetup((s) => s.forceOpen);
  const [firstRun, setFirstRun] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  useEffect(() => { void api.getSetupState().then((s) => { setFirstRun(!!s?.firstRun); setProviders(s?.providers ?? null); }).catch(() => {}); }, []);
  // Once shown it stays mounted: the wizard keeps its own "dismissed" state, as it did before.
  const [shown, setShown] = useState(false);
  const noWizard = !can('setup') && !can('threads.cli');
  if (noWizard) {
    const claude = providers?.find((p) => p.name === 'claude');
    return claude && claude.signedIn === false ? <ConnectAccountPrompt /> : null;
  }
  if ((firstRun || forceOpen) && !shown) setShown(true);
  if (!shown) return null;
  return <Suspense fallback={null}><Impl /></Suspense>;
}
