import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useUpdate } from '../../stores/update';

/**
 * Shared apply-update flow (update modal + Settings → Updates): triggers
 * POST /api/update/apply, tracks the preflight failure reason, and — once an
 * update is in progress (from this client or a broadcast) — polls the server
 * until it comes back reporting a NEW version, then hard-reloads the page so
 * the client (especially the PWA, which never reloads on its own) picks up
 * the new bundle.
 */
export function useApplyUpdate() {
  const inProgress = useUpdate((s) => s.inProgress);
  const [applying, setApplying] = useState(false);
  const [failReason, setFailReason] = useState<string | null>(null);
  const [failDirty, setFailDirty] = useState<{ status: string; path: string }[] | null>(null);
  const [failDirtyOverflow, setFailDirtyOverflow] = useState(0);
  const [canForce, setCanForce] = useState(false);

  const apply = async (force?: boolean) => {
    setApplying(true);
    setFailReason(null);
    setFailDirty(null);
    setFailDirtyOverflow(0);
    setCanForce(false);
    try {
      const res = await api.applyUpdate(force);
      if (res.ok) useUpdate.setState({ inProgress: true });
      else {
        setFailReason(res.reason ?? 'Update could not be applied automatically.');
        setFailDirty(res.dirty ?? null);
        setFailDirtyOverflow(res.dirtyOverflow ?? 0);
        setCanForce(res.forceable === true);
      }
    } catch {
      setFailReason('Could not reach the server to apply the update.');
    } finally {
      setApplying(false);
    }
  };

  useEffect(() => {
    if (!inProgress) return;
    const before = useUpdate.getState().currentVersion;
    const timer = setInterval(async () => {
      try {
        const s = await api.getUpdateState();
        // Only reload once the daemon is BACK and running something new —
        // reloading while it's down would strand the PWA on an error page.
        if (s.currentVersion && s.currentVersion !== before) location.reload();
      } catch { /* daemon restarting — keep polling */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [inProgress]);

  return { apply, applying, failReason, failDirty, failDirtyOverflow, canForce, inProgress };
}
