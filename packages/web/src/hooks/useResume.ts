import { useEffect, useRef } from 'react';

// Fires `onResume` when the app comes back to the foreground after being away
// long enough that iOS likely suspended our sockets. Covers three signals:
//   - visibilitychange: the normal tab/PWA background → foreground
//   - pageshow (persisted): restore from the bfcache
//   - online: the network came back
// A short hide (quick app switch) won't fire, so we don't churn sockets on
// every glance away.
export function useResume(onResume: () => void, thresholdMs = 8000) {
  const ref = useRef(onResume);
  ref.current = onResume;

  useEffect(() => {
    let hiddenAt: number | null = null;
    const fire = () => ref.current();

    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
        hiddenAt = null;
        if (away >= thresholdMs) fire();
      }
    };
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) fire(); };
    const onOnline = () => fire();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
    };
  }, [thresholdMs]);
}
