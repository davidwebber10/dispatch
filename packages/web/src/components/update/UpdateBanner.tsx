import { useState } from 'react';
import { ArrowCircleUp, PuzzlePiece } from '@phosphor-icons/react';
import { api } from '../../api/client';
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
  const pluginUpdates = useUpdate((s) => s.pluginUpdates);
  const { apply, applying, failReason, hosted } = useApplyUpdate();
  // One plugin update runs at a time; the buttons wait for it.
  const [updating, setUpdating] = useState<string | null>(null);
  const [pluginFail, setPluginFail] = useState<string | null>(null);
  const updateOne = async (id: string) => {
    if (updating) return;
    setUpdating(id); setPluginFail(null);
    try { await api.updatePlugin(id); } catch (e) { setPluginFail(e instanceof Error ? e.message : String(e)); }
    try { useUpdate.getState().setPluginUpdates((await api.pluginUpdates()).updates); } catch { /* the next event corrects it */ }
    setUpdating(null);
  };
  const dispatchWaiting = pending && available !== null;
  if (!dispatchWaiting && pluginUpdates.length === 0) return null;
  const next = available ? `v${available.version.replace(/^v/, '')}` : '';

  const pluginsBlock = pluginUpdates.length > 0 && (
    <div role="region" aria-label="Plugin updates" style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, padding: compact ? '12px 14px' : '12px 16px', background: 'rgba(62,207,106,0.06)', border: '1px solid rgba(62,207,106,0.25)', borderRadius: 'var(--radius-lg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PuzzlePiece size={compact ? 22 : 20} weight="fill" color="var(--color-accent)" style={{ flexShrink: 0 }} />
        <div style={{ fontSize: compact ? 14.5 : 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{pluginUpdates.length === 1 ? 'A plugin update is available' : `${pluginUpdates.length} plugin updates are available`}</div>
      </div>
      {pluginUpdates.map((u) => (
        <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: compact ? 32 : 30 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: compact ? 13 : 12.5, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{u.name}</span> {u.from} → {u.to}
          </span>
          <button type="button" aria-label={`Update ${u.name}`} onClick={() => void updateOne(u.id)} disabled={updating !== null} style={{ flexShrink: 0, height: 28, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-sm)', color: 'var(--color-accent)', fontWeight: 600, fontSize: 12, cursor: updating ? 'default' : 'pointer', opacity: updating && updating !== u.id ? 0.6 : 1 }}>
            {updating === u.id ? 'Updating…' : 'Update'}
          </button>
        </div>
      ))}
      {pluginFail && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)', paddingLeft: compact ? 32 : 30 }}>{pluginFail}</div>}
    </div>
  );
  if (!dispatchWaiting || !available) return <>{pluginsBlock}</>;

  return (
    <>
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
    {pluginsBlock}
    </>
  );
}
