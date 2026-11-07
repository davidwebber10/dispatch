import { ArrowCircleUp } from '@phosphor-icons/react';
import { useUpdate, updatePending } from '../../stores/update';
import { useApplyUpdate } from './useApplyUpdate';

/**
 * The banner at the top of Settings (desktop page and phone list) while an update waits:
 * the version, the one running, and an Update button. It stays after the update modal is
 * dismissed, so Settings is always a place to find the update. Gone once an update is
 * running (the progress window takes over) or done.
 */
export function UpdateBanner({ compact = false }: { compact?: boolean }) {
  const pending = useUpdate(updatePending);
  const available = useUpdate((s) => s.available);
  const currentVersion = useUpdate((s) => s.currentVersion);
  const { apply, applying, failReason, hosted } = useApplyUpdate();
  if (!pending || !available) return null;
  const next = `v${available.version.replace(/^v/, '')}`;

  return (
    <div role="region" aria-label="Update available" style={{
      display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0,
      padding: compact ? '12px 14px' : '12px 16px',
      background: 'rgba(62,207,106,0.10)', border: '1px solid rgba(62,207,106,0.35)', borderRadius: 'var(--radius-lg)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ArrowCircleUp size={compact ? 24 : 22} weight="fill" color="var(--color-accent)" style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: compact ? 15 : 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>Dispatch {next} is available</div>
          <div style={{ marginTop: 2, fontSize: compact ? 12 : 11.5, color: 'var(--color-text-secondary)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {currentVersion && <span>You run v{currentVersion}.</span>}
            {available.url && <a href={available.url} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent)', textDecoration: 'none' }}>Release notes</a>}
          </div>
        </div>
        <button type="button" onClick={() => void apply()} disabled={applying} style={{
          flexShrink: 0, height: compact ? 34 : 30, padding: compact ? '0 16px' : '0 14px',
          background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-sm)',
          color: '#08240F', fontWeight: 600, fontSize: compact ? 13.5 : 12.5, cursor: applying ? 'default' : 'pointer', opacity: applying ? 0.7 : 1,
        }}>
          {applying ? 'Updating…' : 'Update now'}
        </button>
      </div>
      {failReason && (
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
          Couldn't update automatically: {failReason}{' '}
          {hosted
            ? 'Your workspace updates when it is rebuilt onto a newer image — ask an administrator if this keeps failing.'
            : <>Run <code style={{ font: '400 11px var(--font-mono)' }}>dispatch update</code> manually instead.</>}
        </div>
      )}
    </div>
  );
}
