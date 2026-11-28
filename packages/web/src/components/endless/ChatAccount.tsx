import { useEffect, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import { useAccounts, shortAccountLabel } from '../../stores/accounts';
import { useUsageLimits } from '../../stores/usageLimits';
import { useEndless } from '../../stores/endless';
import { useNow } from '../../hooks/useNow';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Modal } from '../common/Modal';
import { ProviderRing } from '../layout/UsageChip';
import { chipRings, ringModels, type ChipRing } from '../layout/usageGauge';
import { fontVar } from '../../lib/fontSize';

const PROVIDER = 'claude-code';

/**
 * The account that runs Chat: the one Chat is pinned to, else the default Claude account.
 * `switchable` is false against a daemon that has no such setting.
 */
export function useChatAccount() {
  const view = useAccounts((s) => s.view);
  const settings = useEndless((s) => s.settings);
  useEffect(() => { void useAccounts.getState().load(); }, []);
  useEffect(() => { if (!useUsageLimits.getState().summary) void useUsageLimits.getState().load(); }, []);
  const accounts = view?.claude ?? [];
  const defaultId = view?.defaults.claude ?? 'cli';
  const pinned = settings?.accountId && accounts.some((a) => a.id === settings.accountId) ? settings.accountId : null;
  const id = pinned ?? defaultId;
  const account = accounts.find((a) => a.id === id) ?? null;
  return { accounts, defaultId, pinned, id, label: account ? shortAccountLabel(account.label) : null, switchable: settings?.accountId !== undefined };
}

/** The usage ring of one Claude account, with an empty ring while it has no figure. */
export function useAccountRing(accountId: string, model?: string | null): ChipRing {
  const summary = useUsageLimits((s) => s.summary);
  const now = useNow(60_000);
  return chipRings(summary, now, undefined, { model }).find((r) => r.provider === PROVIDER && r.accountId === accountId)
    ?? { provider: PROVIDER, accountId, name: 'Claude', used: null, type: null, tone: 'green', paused: false, stale: false, title: 'Claude: no usage figure yet' };
}

/** Every window of one account in words: "5-hour 41% used · weekly 59% used". */
function useWindowsText(): (accountId: string) => string {
  const summary = useUsageLimits((s) => s.summary);
  const now = useNow(60_000);
  const models = ringModels(summary, now).filter((m) => m.provider === PROVIDER);
  return (accountId) => {
    const m = models.find((x) => x.accountId === accountId);
    const rows = m?.rows.filter((r) => r.left !== null) ?? [];
    return rows.length ? rows.map((r) => `${r.label} ${100 - (r.left as number)}% used`).join(' · ') : 'No usage figure yet';
  };
}

function Ring({ accountId }: { accountId: string }) {
  return <ProviderRing ring={useAccountRing(accountId)} size={28} />;
}

/** The usage of every Claude account, and the switch of the account that runs Chat. */
export function ChatAccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mobile = useIsMobile();
  const { accounts, defaultId, pinned, switchable } = useChatAccount();
  const windows = useWindowsText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setError(null); void useAccounts.getState().reload(); } }, [open]);

  const pick = async (accountId: string | null) => {
    if (busy || accountId === pinned) return;
    setBusy(true);
    setError(null);
    try { await useEndless.getState().saveSettings({ accountId }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not change the account.'); }
    finally { setBusy(false); }
  };

  const defaultLabel = shortAccountLabel(accounts.find((a) => a.id === defaultId)?.label ?? defaultId);
  const options = [
    { key: 'default', value: null as string | null, ringId: defaultId, title: 'Default account', note: `Follows Settings: now ${defaultLabel}` },
    ...accounts.map((a) => ({ key: a.id, value: a.id as string | null, ringId: a.id, title: shortAccountLabel(a.label), note: windows(a.id) })),
  ];

  return (
    <Modal open={open} sheet={mobile} title="Chat account" onClose={onClose} maxWidth={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ fontSize: fontVar(13), color: 'var(--color-text-secondary)' }}>
          {switchable ? 'Chat runs on this Claude account. A change applies from the next message.' : 'This daemon cannot change the Chat account. Update it first.'}
        </span>
        <div role="radiogroup" aria-label="Chat account" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {options.map((o) => {
            const on = o.value === pinned;
            return (
              <button key={o.key} type="button" role="radio" aria-checked={on} disabled={!switchable || busy} onClick={() => void pick(o.value)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: mobile ? '11px 12px' : '9px 10px', background: 'transparent', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', cursor: switchable ? 'pointer' : 'default', font: 'inherit' }}>
                <span style={{ width: 16, flexShrink: 0, display: 'inline-flex', justifyContent: 'center', color: 'var(--color-accent)' }}>{on && <Check size={14} weight="bold" />}</span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: fontVar(mobile ? 15 : 13.5), fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.title}</span>
                  <span style={{ font: `400 ${fontVar(11)} var(--font-mono)`, color: 'var(--color-text-tertiary)' }}>{o.note}</span>
                </span>
                <span style={{ flexShrink: 0, display: 'inline-flex' }}><Ring accountId={o.ringId} /></span>
              </button>
            );
          })}
        </div>
        {error && <div role="alert" style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)' }}>{error}</div>}
      </div>
    </Modal>
  );
}
