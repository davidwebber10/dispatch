import type { UsagePausedGroup } from '../../api/types';
import { useUsageLimits } from '../../stores/usageLimits';
import { useSettings } from '../../stores/settings';
import { useDismissedNotices, USAGE_BANNER_SCOPE, usageBannerKey, usageBannerDismissed } from '../../stores/dismissedNotices';
import { useUI } from '../../stores/ui';
import { bannerText, CHAT_PARK_ID } from './usageGauge';
import { useNow } from '../../hooks/useNow';
import { fontVar } from '../../lib/fontSize';

/**
 * The red global banner while any thread is paused on a usage limit (#127). One line per provider.
 * Click opens the first paused thread (or Chat). The × hides it on this device until a newer pause starts; Settings > Usage limits hides it on this device for good.
 */
export function UsageBanner({ onOpenChat, compact = false }: { onOpenChat?: () => void; compact?: boolean }) {
  const now = useNow();
  const summary = useUsageLimits((s) => s.summary);
  const show = useSettings((s) => s.showUsageBanner);
  const dismissed = useDismissedNotices((s) => s.keys);
  if (!show || !summary) return null;
  const startedAt = (g: UsagePausedGroup) => g.latestStartedAt ?? g.episodeStartedAt;
  const groups = summary.paused.filter((g) => !usageBannerDismissed(dismissed, g.provider, startedAt(g)));
  if (groups.length === 0) return null;
  const open = (g: UsagePausedGroup) => {
    if (g.firstTerminalId === CHAT_PARK_ID || !g.firstSessionId) { if (onOpenChat) onOpenChat(); else useUI.getState().setView('chat'); return; }
    useUI.getState().setView('workspace');
    useUI.getState().requestOpenThread({ sessionId: g.firstSessionId, terminalId: g.firstTerminalId });
  };
  return (
    <div data-testid="usage-banner" role="status" style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'color-mix(in srgb, var(--color-status-red) 14%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--color-status-red) 45%, transparent)' }}>
      {groups.map((g) => (
        <div key={g.provider} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: compact ? '4px 6px 4px 12px' : '3px 6px 3px 14px', minWidth: 0 }}>
          <button type="button" onClick={() => open(g)}
            style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', color: 'var(--color-status-red)', fontSize: fontVar(compact ? 13 : 12.5), fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {bannerText(g, now)}
          </button>
          <button type="button" aria-label="Hide until the next pause" title="Hide until the next pause"
            onClick={() => useDismissedNotices.getState().dismiss(USAGE_BANNER_SCOPE, usageBannerKey(g.provider, startedAt(g)))}
            style={{ flexShrink: 0, minWidth: compact ? 44 : 28, minHeight: compact ? 36 : 26, background: 'none', border: 'none', color: 'var(--color-status-red)', fontSize: fontVar(16), cursor: 'pointer', padding: 0 }}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
