import { useCallback, useEffect, useState } from 'react';
import { DeviceMobile, DeviceTablet, Desktop, type Icon } from '@phosphor-icons/react';
import { api, ApiError, type DeviceInfo, type DeviceList } from '../../api/client';
import { timeAgo } from '../../lib/time';
import { reloadFresh } from '../../lib/shellCache';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ConfirmModal } from '../common/ConfirmModal';
import { SettingsGroup, SettingsRow, SettingsSubPage, EmptyState, ghostBtn, solidBtn, fieldFor, sectionLabel } from './ui';

/**
 * Settings → Devices & access: signed-in devices (network exposure spec, 8.1 and 8.2).
 *
 * One row per browser or phone that signed in. Revoke ends that one device and no other. A
 * browser on the computer itself, or on the owner's own Tailscale, needs no sign-in and has no
 * row. "Signed in before the device list" rows are browsers that held the old shared cookie:
 * Dispatch gives each one its own cookie the next time it opens the app.
 *
 * 2026-11-07 (docs/design/settings-layout.md): a "Signed-in devices" group of list rows; each
 * device's page holds its details, Rename, and Revoke (behind a confirm). Ending the older
 * sign-ins is the destructive group at the bottom. `extra` (AccessSection's token disclosure)
 * sits between the list and that group, as the guide orders a page.
 */
export function addressLabel(addr: string | null, kind: DeviceInfo['addressKind']): string {
  if (!addr) return 'Unknown address';
  if (kind === 'local') return 'This computer';
  if (kind === 'gateway') return 'Windows host (WSL)';
  // A proxy on this computer reported it; Dispatch cannot check it.
  if (kind === 'forwarded') return `${addr} (via proxy)`;
  return addr;
}

const viaLabel = (v: DeviceInfo['signedInVia']) =>
  v === 'code' ? 'With a sign-in code' : v === 'token' ? 'With the access token' : 'Before the device list';

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** A phone, a tablet or a computer, from the name the browser gave itself. */
function deviceIcon(name: string): Icon {
  if (/ipad|tablet/i.test(name)) return DeviceTablet;
  if (/iphone|android|phone|pixel|galaxy|mobile/i.test(name)) return DeviceMobile;
  return Desktop;
}

/** A group's label with an empty state in place of its card (local; the shape SettingsGroup could take as `empty`). */
function EmptyGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section role="group" aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ minHeight: 22, display: 'flex', alignItems: 'center', padding: '0 4px' }}><span style={{ ...sectionLabel, textTransform: 'uppercase' }}>{title}</span></div>
      <EmptyState>{children}</EmptyState>
    </section>
  );
}

type Confirm = { kind: 'revoke'; device: DeviceInfo } | { kind: 'legacy' } | null;

export function DevicesList({ now = Date.now, reload = () => { void reloadFresh(); }, openId: openProp, onOpen, onClose, onRenamed, backLink = true, extra }: {
  now?: () => number; reload?: () => void;
  /** The open device's page, when the parent keeps it (AccessSection, for phone history); else local. */
  openId?: string | null; onOpen?: (id: string, name: string) => void; onClose?: () => void;
  /** A device was renamed on its own page (the phone header shows the new name). */
  onRenamed?: (name: string) => void;
  /** Show the "‹ Devices & access" link on a device's page (desktop). */
  backLink?: boolean;
  /** Rows the parent puts after the list and before the destructive group (a disclosure). */
  extra?: React.ReactNode;
}) {
  const [data, setData] = useState<DeviceList | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const openId = openProp !== undefined ? openProp : localOpen;
  const open = (id: string, name: string) => { setError(null); if (onOpen) onOpen(id, name); else setLocalOpen(id); };
  const close = () => { setError(null); if (onClose) onClose(); else setLocalOpen(null); };

  const load = useCallback(async () => {
    try {
      setData(await api.getDevices());
      setState('ready');
    } catch (e) {
      setState(e instanceof ApiError && e.status === 404 ? 'unavailable' : 'error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const opened = openId && data ? data.devices.find((d) => d.id === openId) : undefined;
  // The name field starts as the device's name each time its page opens.
  useEffect(() => { if (opened) setDraft(opened.name); }, [opened?.id, opened?.name]);

  async function revoke(d: DeviceInfo) {
    setBusy(true); setError(null); setConfirm(null);
    try {
      await api.revokeDevice(d.id);
      if (d.current) return reload(); // this browser just lost its sign-in: land on the sign-in page
      close();
      await load();
    } catch {
      setError(`Could not revoke ${d.name}. Try again.`);
    } finally { setBusy(false); }
  }

  async function rename(d: DeviceInfo) {
    const name = draft.trim();
    if (!name || name === d.name) return;
    setBusy(true); setError(null);
    try {
      await api.renameDevice(d.id, name);
      onRenamed?.(name);
      await load();
    } catch {
      setError('Could not rename the device. Try again.');
    } finally { setBusy(false); }
  }

  async function endLegacy() {
    setBusy(true); setError(null); setConfirm(null);
    try {
      await api.endLegacyDevices();
      await load();
    } catch {
      setError('Could not sign those devices out. Try again.');
    } finally { setBusy(false); }
  }

  const t = now();
  const lastActive = (d: DeviceInfo) => (t - d.lastSeenAt < 5000 ? 'now' : `${timeAgo(new Date(d.lastSeenAt).toISOString(), t)} ago`);
  const errorLine = error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</div>;

  const confirmModal = (
    <>
      <ConfirmModal open={confirm?.kind === 'revoke'} danger
        title={confirm?.kind === 'revoke' ? (confirm.device.current ? 'Sign out this device?' : `Revoke ${confirm.device.name}?`) : ''}
        confirmLabel={confirm?.kind === 'revoke' && confirm.device.current ? 'Sign out' : 'Revoke'}
        message={confirm?.kind === 'revoke' && confirm.device.current
          ? 'This will sign you out here. You will need a new code or the access token to come back.'
          : 'That device will be signed out at once. It needs a new code or the access token to come back. Every other device stays signed in.'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm?.kind === 'revoke') void revoke(confirm.device); }} />
      <ConfirmModal open={confirm?.kind === 'legacy'} danger title="Sign out older devices?" confirmLabel="Sign them out"
        message="A device that has not opened Dispatch since the update will need to sign in again. Every device in the list stays signed in."
        onCancel={() => setConfirm(null)} onConfirm={() => void endLegacy()} />
    </>
  );

  // One device's page.
  if (opened) {
    const d = opened;
    const changed = !!draft.trim() && draft.trim() !== d.name;
    return (
      <div>
        <SettingsSubPage testId="device-page" icon={deviceIcon(d.name)} title={d.name}
          subtitle={d.current ? 'This device' : `Last active ${lastActive(d)}`}
          backLabel="Devices & access" onBack={backLink ? close : undefined}>
          {errorLine}
          <SettingsGroup title="Name">
            <SettingsRow label="Device name" hint="Only for this list.">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input aria-label="Device name" value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void rename(d); }}
                  style={{ ...fieldFor(isMobile), flex: 1 }} />
                <button type="button" disabled={busy || !changed} style={{ ...solidBtn(!busy && changed), height: isMobile ? 36 : 30 }} onClick={() => void rename(d)}>Save</button>
              </div>
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title="Sign-in">
            <SettingsRow label="Signed in" value={viaLabel(d.signedInVia)} />
            <SettingsRow label="Address" value={addressLabel(d.lastAddress, d.addressKind)} />
            <SettingsRow label="First seen" value={day(d.createdAt)} />
            <SettingsRow label="Last active" value={lastActive(d)} />
          </SettingsGroup>
          <SettingsGroup>
            <SettingsRow danger label={d.current ? 'Sign out this device' : 'Revoke this device'} ariaLabel={d.current ? 'Sign out this device' : 'Revoke this device'}
              hint={d.current ? 'You will need a new code to come back.' : 'Every other device stays signed in.'}
              onClick={() => setConfirm({ kind: 'revoke', device: d })} />
          </SettingsGroup>
        </SettingsSubPage>
        {confirmModal}
      </div>
    );
  }

  if (state === 'loading') return <><EmptyGroup title="Signed-in devices">Loading…</EmptyGroup>{extra}</>;
  if (state === 'unavailable') return <><EmptyGroup title="Signed-in devices">The device list is not available on this Dispatch.</EmptyGroup>{extra}</>;
  if (state === 'error' || !data) {
    return (
      <>
        <section role="group" aria-label="Signed-in devices">
          <EmptyState action={<button type="button" style={ghostBtn} onClick={() => void load()}>Try again</button>}>Could not load the device list.</EmptyState>
        </section>
        {extra}
      </>
    );
  }

  const footer = (
    <span data-testid="tailscale-note">
      {data.currentDeviceId === null && 'This browser needs no sign-in, so it is not listed. '}
      Devices on your Tailscale need no sign-in and are not listed. Manage them in the Tailscale admin console.
    </span>
  );

  return (
    <>
      {data.devices.length === 0 ? (
        <section role="group" aria-label="Signed-in devices" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ minHeight: 22, display: 'flex', alignItems: 'center', padding: '0 4px' }}><span style={{ ...sectionLabel, textTransform: 'uppercase' }}>Signed-in devices</span></div>
          <EmptyState>No device has signed in yet. Make a code to sign in a phone.</EmptyState>
          <div style={{ padding: '0 4px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-text-tertiary)' }}>{footer}</div>
        </section>
      ) : (
        <SettingsGroup title="Signed-in devices" footer={footer}>
          {data.devices.map((d) => (
            <div key={d.id} data-testid="device-row">
              <SettingsRow icon={deviceIcon(d.name)} label={d.name} ariaLabel={`${d.name}: open`}
                hint={<span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Last active {lastActive(d)} · {addressLabel(d.lastAddress, d.addressKind)}</span>}
                value={d.current ? <span style={{ color: 'var(--color-accent)' }}>This device</span> : undefined}
                onClick={() => open(d.id, d.name)} />
            </div>
          ))}
        </SettingsGroup>
      )}
      {errorLine}
      {extra}
      {data.legacyOpen && (
        <SettingsGroup title="Older sign-ins" footer="Phones and browsers that signed in before this list show up here the next time they open Dispatch.">
          <SettingsRow danger label="Sign out devices not in this list" ariaLabel="Sign out devices not in this list"
            hint="Do this once all your devices appear above." onClick={() => setConfirm({ kind: 'legacy' })} />
        </SettingsGroup>
      )}
      {confirmModal}
    </>
  );
}
