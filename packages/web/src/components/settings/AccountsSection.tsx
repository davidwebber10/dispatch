import { useEffect, useState } from 'react';
import { Plus, SignIn, Info, ClockCounterClockwise, type Icon as PhosphorIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { Account, AccountProvider, AccountsView, AccountThread } from '../../api/types';
import { ConfirmModal } from '../common/ConfirmModal';
import { ClaudeLogin } from '../endless/ClaudeLogin';
import { HARNESS_MARK } from '../common/HarnessStrip';
import { CodexLogin } from './CodexLogin';
import { SettingsPage, SettingsGroup, SettingsRow, SettingsSubPage, StatusMark, Sheet, fieldFor, noteText } from './ui';
import { useSubPage } from './subPageNav';
import { useIsMobile } from '../../hooks/useIsMobile';
import { USAGE_ACCESS_TEXT, updatedAgo, usageAccessOf } from '../../stores/accounts';
import { Button } from '../ui';
import { fontVar } from '../../lib/fontSize';

/**
 * Settings → Accounts (multi-account spec 2026-11-06): the signed-in accounts under each harness,
 * which one new threads use by default, add one, remove one. `cli` is the CLI's own login on the
 * daemon's computer and is always there. A Claude account is added with the headless login (open
 * the page, paste the code). A Codex account gets its own folder and is signed in right here with
 * the device code (`codex login --device-auth` in that folder, CodexLogin), which works from a
 * phone. A Codex account with no login (an add that failed or was left) offers "Sign in again".
 *
 * Layout (2026-11-07, docs/design/settings-layout.md): one group per harness, one row per account
 * (name, one line of detail, "Default" as the value). A row opens the account's own page: rename,
 * default, sign in, remove. "Add account" sits on the group's label and opens a sheet.
 *
 * Usage figures (W1-H, 2026-11-09): a Claude account whose usage read is refused says so on its page,
 * with the next step. `sign-in-needed`: "Sign in again" runs the Claude login for THAT account (its
 * token is replaced in place). `not-available`: a plain note (the sign-in runs threads but may not
 * read usage; nothing is wrong). `rate-limited`: when usage was last read. "Check again" reads now.
 */
const PROVIDER_TITLE: Record<AccountProvider, string> = { claude: 'Claude', codex: 'Codex' };
const MARK: Record<AccountProvider, PhosphorIcon> = {
  // The brand mark in the settings icon tile (IconTile draws any component that takes a `size`).
  claude: HARNESS_MARK.claude as unknown as PhosphorIcon,
  codex: HARNESS_MARK.codex as unknown as PhosphorIcon,
};
const errText: React.CSSProperties = { fontSize: fontVar(12.5), color: 'var(--color-status-red)' };
const oneLine: React.CSSProperties = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const threadsLabel = (n: number) => `${n} thread${n === 1 ? '' : 's'}`;

export function AccountsSection() {
  const nav = useSubPage('accounts');
  const isMobile = useIsMobile();
  const [view, setView] = useState<AccountsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<AccountProvider | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  // Remove: the confirm names the threads pinned to the account (they revert to the default).
  const [removing, setRemoving] = useState<{ provider: AccountProvider; account: Account; threads: AccountThread[] } | null>(null);
  // The Codex account whose device-code sign-in shows now (a new one, or "Sign in again").
  const [codexSignIn, setCodexSignIn] = useState<string | null>(null);
  // The Claude account whose "Sign in again" login shows now (W1-H).
  const [claudeSignIn, setClaudeSignIn] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const checkUsage = async (id: string) => {
    setChecking(true);
    try { await api.accountsCheckUsage(id); await new Promise((r) => setTimeout(r, 1500)); await load(); } catch { setError('Could not check the account.'); }
    finally { setChecking(false); }
  };

  const load = async () => {
    try { setView(await api.getAccounts()); setError(null); } catch { setError('Could not load the accounts. Is the daemon up to date?'); }
  };
  useEffect(() => { void load(); }, []);

  const setDefault = async (provider: AccountProvider, id: string) => {
    try { await api.accountsSetDefault(provider, id); await load(); } catch { setError('Could not change the default.'); }
  };
  const askRemove = async (provider: AccountProvider, a: Account) => {
    let threads: AccountThread[] = [];
    try { threads = await api.accountsThreads(provider, a.id); } catch { /* an older daemon: no list, the notice stays general */ }
    setRemoving({ provider, account: a, threads });
  };
  const remove = async () => {
    const r = removing;
    setRemoving(null);
    if (!r) return;
    try { await api.accountsRemove(r.provider, r.account.id); nav.close(); await load(); } catch { setError('Could not remove the account.'); }
  };
  const rename = async (provider: AccountProvider, id: string, name: string) => {
    try { await api.accountsRename(provider, id, name); nav.retitle(name); await load(); return true; } catch { setError('Could not rename the account.'); return false; }
  };
  /** The notice under "Remove …?": which threads run on it, and what they fall back to. */
  const removeMessage = (r: { provider: AccountProvider; account: Account; threads: AccountThread[] }) => {
    const def = view?.[r.provider].find((a) => a.id === view.defaults[r.provider] && a.id !== r.account.id) ?? view?.[r.provider].find((a) => a.isCli);
    const fallback = def ? `"${def.label}"` : 'the default account';
    if (r.threads.length === 0) return `No thread is set to "${r.account.label}". New threads can no longer pick it.`;
    const names = r.threads.slice(0, 6).map((t) => `"${t.label}"`).join(', ') + (r.threads.length > 6 ? ` and ${r.threads.length - 6} more` : '');
    return `${r.threads.length === 1 ? '1 thread runs' : `${r.threads.length} threads run`} on "${r.account.label}": ${names}. ${r.threads.length === 1 ? 'It' : 'They'} will use ${fallback} the next time ${r.threads.length === 1 ? 'it starts' : 'they start'}.`;
  };

  /** A new Codex account: make its folder, then sign it in here. A failed or left sign-in leaves it listed with "Sign in again". */
  const addCodex = async () => {
    setBusy(true);
    try {
      const a = await api.accountsAddCodex(label);
      setCodexSignIn(a.id);
      await load();
    } catch { setError('Could not add the Codex account.'); }
    finally { setBusy(false); }
  };
  const codexSignInEnded = () => { setCodexSignIn(null); setAdding(null); setLabel(''); void load(); };
  const closeAdd = () => { if (adding === 'codex' && codexSignIn) { codexSignInEnded(); return; } setAdding(null); setLabel(''); };

  const confirm = (
    <ConfirmModal
      open={!!removing}
      title={removing ? `Remove "${removing.account.label}"?` : ''}
      message={removing ? removeMessage(removing) : ''}
      confirmLabel="Remove"
      danger
      onConfirm={() => void remove()}
      onCancel={() => setRemoving(null)}
    />
  );

  // The account's own page: `<provider>:<id>` in the sub-page state.
  const [openProvider, openAccountId] = (nav.openId ?? '').split(':') as [AccountProvider | '', string | undefined];
  const opened = openProvider && openAccountId ? view?.[openProvider]?.find((a) => a.id === openAccountId) : undefined;
  if (opened && view && openProvider) {
    const provider = openProvider;
    const a = opened;
    const isDefault = view.defaults[provider] === a.id;
    const access = provider === 'claude' ? usageAccessOf(a) : null;
    const checkAgain = (
      <Button aria-label={`Check usage again for ${a.label}`} disabled={checking} onClick={() => void checkUsage(a.id)} variant="ghost" size="sm">{checking ? 'Checking…' : 'Check again'}</Button>
    );
    const accessNote = (Icon: PhosphorIcon, text: string) => (
      <span data-testid="usage-access-note" style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6 }}>
        <Icon size={14} style={{ flexShrink: 0, marginTop: 1 }} /><span>{text}</span>
      </span>
    );
    return (
      <div ref={nav.top}>
        <SettingsSubPage testId={`account-detail-${provider}-${a.id}`} icon={MARK[provider]} title={a.label}
          subtitle={`${PROVIDER_TITLE[provider]}${isDefault ? ' · Default for new threads' : ''}`}
          description={a.isCli ? "The login signed in on the daemon's computer. It always stays here; you can rename it." : undefined}
          backLabel="Accounts" onBack={nav.isMobile ? undefined : nav.close}>
          {error && <div role="alert" style={errText}>{error}</div>}

          <SettingsGroup title="Account">
            <AccountName key={`${provider}:${a.id}`} account={a} isMobile={isMobile} onSave={(name) => rename(provider, a.id, name)} />
            {a.email && <SettingsRow label="Email" value={a.email} />}
            {a.plan && <SettingsRow label="Plan" value={a.plan} />}
            {provider === 'codex' && !a.isCli && a.signedIn !== undefined && (
              <SettingsRow label="Sign-in" control={a.signedIn ? <StatusMark tone="accent">Signed in</StatusMark> : <StatusMark tone="yellow">Not signed in</StatusMark>} />
            )}
            <SettingsRow label="Threads on it" value={a.threadCount ? threadsLabel(a.threadCount) : 'None'} />
          </SettingsGroup>

          {provider === 'codex' && !a.isCli && a.signedIn === false && (
            <SettingsGroup title="Sign in">
              <SettingsRow label="Sign in to ChatGPT" hint="This account has no login yet. Dispatch shows a link and a code to use on any device."
                control={codexSignIn !== a.id
                  ? <Button aria-label={`Sign in again to ${a.label}`} onClick={() => { setAdding(null); setCodexSignIn(a.id); }} variant="primary" size="sm">Sign in</Button>
                  : undefined}>
                {codexSignIn === a.id && adding === null && <CodexLogin accountId={a.id} onDone={codexSignInEnded} onCancel={codexSignInEnded} />}
              </SettingsRow>
            </SettingsGroup>
          )}

          {access && (
            <SettingsGroup title="Usage figures">
              {access.state === 'sign-in-needed' && (
                <SettingsRow label="Sign in again" hint={accessNote(SignIn, a.isCli ? USAGE_ACCESS_TEXT.signInCli : USAGE_ACCESS_TEXT.signIn)}
                  control={!a.isCli && claudeSignIn !== a.id
                    ? <Button aria-label={`Sign in again to ${a.label}`} onClick={() => setClaudeSignIn(a.id)} variant="primary" size="sm" icon={<SignIn size={14} weight="bold" />}>Sign in again</Button>
                    : undefined}>
                  {!a.isCli && claudeSignIn === a.id && (
                    <ClaudeLogin autoStart buttonLabel="Sign in again" start={() => api.accountsClaudeLogin(a.label, a.id)} onDone={() => { setClaudeSignIn(null); void checkUsage(a.id); }} />
                  )}
                </SettingsRow>
              )}
              {access.state === 'not-available' && (
                <SettingsRow label="Not available for this sign-in" hint={accessNote(Info, USAGE_ACCESS_TEXT.notAvailable)} />
              )}
              {access.state === 'rate-limited' && (
                <SettingsRow label="Claude limits how often usage is read" hint={accessNote(ClockCounterClockwise, access.lastOkAt === null ? 'No figures read yet. Dispatch waits, then reads again.' : `${updatedAgo(access.lastOkAt, Date.now())}. Dispatch waits, then reads again.`)} />
              )}
              <SettingsRow label="Check again" hint="Read this account's usage now." control={checkAgain} />
            </SettingsGroup>
          )}

          <SettingsGroup title="New threads">
            <SettingsRow label="Default account" hint={`New ${PROVIDER_TITLE[provider]} threads use it unless you pick another.`}
              control={isDefault
                ? <StatusMark tone="accent">Default</StatusMark>
                : <Button aria-label={`Make ${a.label} the default`} onClick={() => void setDefault(provider, a.id)} variant="ghost" size="sm">Make default</Button>} />
          </SettingsGroup>

          {!a.isCli && (
            <SettingsGroup footer="Threads set to it switch to the default account the next time they start.">
              <SettingsRow label="Remove account" ariaLabel="Remove account" danger onClick={() => void askRemove(provider, a)} />
            </SettingsGroup>
          )}
        </SettingsSubPage>
        {confirm}
      </div>
    );
  }

  const list = (provider: AccountProvider) => {
    const accounts = view?.[provider] ?? [];
    const def = view?.defaults[provider];
    return (
      <SettingsGroup title={PROVIDER_TITLE[provider]}
        action={
          <Button variant="ghost" size="sm" icon={<Plus size={12} weight="bold" />} aria-label={`Add ${PROVIDER_TITLE[provider]} account`} onClick={() => { setAdding(provider); setLabel(''); setCodexSignIn(null); }}
            style={{ height: 26, padding: '0 10px', gap: 5 }}>
            Add account
          </Button>
        }>
        {!view
          ? <SettingsRow label={error ? 'Not loaded' : 'Loading…'} />
          : accounts.map((a) => {
            const detail = [a.email, a.plan, a.threadCount ? threadsLabel(a.threadCount) : null].filter(Boolean).join(' · ')
              || (a.isCli ? 'The CLI’s own login' : '');
            return (
              <div key={a.id} data-testid={`account-${provider}-${a.id}`}>
                <SettingsRow icon={MARK[provider]} label={a.label} ariaLabel={`${PROVIDER_TITLE[provider]}: ${a.label}`}
                  hint={a.signedIn === false ? <StatusMark tone="yellow">Not signed in</StatusMark>
                    : provider === 'claude' && usageAccessOf(a)?.state === 'sign-in-needed' ? <StatusMark tone="yellow">Sign in again</StatusMark>
                    : detail ? <span style={oneLine}>{detail}</span> : undefined}
                  value={def === a.id ? 'Default' : undefined}
                  onClick={() => nav.open(`${provider}:${a.id}`, a.label)} />
              </div>
            );
          })}
      </SettingsGroup>
    );
  };

  const addTitle = adding ? `Add a ${PROVIDER_TITLE[adding]} account` : undefined;
  return (
    <div ref={nav.top}>
      <SettingsPage intro="New threads use the default account unless you pick another. Usage limits show every account.">
        {error && <div role="alert" style={errText}>{error}</div>}
        {list('claude')}
        {list('codex')}
      </SettingsPage>
      <Sheet open={adding !== null} onClose={closeAdd} title={addTitle}>
        {adding && (
          <>
            {!(adding === 'codex' && codexSignIn) && (
              <input aria-label="Account name" value={label} onChange={(e) => setLabel(e.target.value)}
                placeholder={adding === 'claude' ? 'Name, like Work or Personal (optional)' : 'Name, like Work or Personal'}
                style={{ ...fieldFor(isMobile), width: '100%', boxSizing: 'border-box' }} />
            )}
            {adding === 'claude' ? (
              <ClaudeLogin buttonLabel="Log in to the new Claude account" start={() => api.accountsClaudeLogin(label)} onDone={() => { setAdding(null); setLabel(''); void load(); }} />
            ) : codexSignIn ? (
              <CodexLogin accountId={codexSignIn} onDone={codexSignInEnded} onCancel={codexSignInEnded} />
            ) : (
              <>
                <div style={noteText}>Dispatch shows a link and a code. Open the link on any device, sign in to ChatGPT, and enter the code.</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button disabled={busy} onClick={() => void addCodex()} variant="primary" size="sm" style={{ height: isMobile ? 36 : 30 }}>Add and sign in</Button>
                  <Button onClick={closeAdd} variant="ghost" size="sm" style={{ height: isMobile ? 36 : 30 }}>Cancel</Button>
                </div>
              </>
            )}
          </>
        )}
      </Sheet>
      {confirm}
    </div>
  );
}

/** The account's name: a field and Save. The CLI login starts empty; empty restores its stock name. */
function AccountName({ account: a, isMobile, onSave }: { account: Account; isMobile: boolean; onSave: (name: string) => Promise<boolean> }) {
  const initial = a.isCli ? '' : a.label;
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const changed = draft !== initial;
  const save = async () => {
    if (saving) return;
    setSaving(true);
    await onSave(draft);
    setSaving(false);
  };
  return (
    <SettingsRow label="Name" hint={a.isCli ? 'Leave it empty to use the stock name.' : 'How the account reads in the New Thread window and Usage limits.'}>
        <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
          <input aria-label="New name" value={draft} placeholder={a.isCli ? 'CLI login (this computer)' : 'Name'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } if (e.key === 'Escape') setDraft(initial); }}
            style={{ ...fieldFor(isMobile), flex: 1, minWidth: 0, boxSizing: 'border-box' }} />
          <Button variant="primary" size="sm" aria-label="Save name" disabled={!changed || saving} onClick={() => void save()}
            style={{ height: isMobile ? 36 : 30 }}>Save</Button>
        </div>
      </SettingsRow>
  );
}
