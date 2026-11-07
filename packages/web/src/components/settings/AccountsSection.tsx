import { useEffect, useState } from 'react';
import { Star, Trash, Plus, PencilSimple, SignIn } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { Account, AccountProvider, AccountsView, AccountThread } from '../../api/types';
import { ConfirmModal } from '../common/ConfirmModal';
import { ClaudeLogin } from '../endless/ClaudeLogin';
import { CodexLogin } from './CodexLogin';
import { sectionLabel, row, item, fieldInput, solidBtn, ghostBtn, Divider, miniChip } from './ui';

/**
 * Settings → Accounts (multi-account spec 2026-11-06): the signed-in accounts under each harness,
 * which one new threads use by default, add one, remove one. `cli` is the CLI's own login on the
 * daemon's computer and is always there. A Claude account is added with the headless login (open
 * the page, paste the code). A Codex account gets its own folder and is signed in right here with
 * the device code (`codex login --device-auth` in that folder, CodexLogin), which works from a
 * phone. A Codex account with no login (an add that failed or was left) offers "Sign in again".
 */
const PROVIDER_TITLE: Record<AccountProvider, string> = { claude: 'Claude', codex: 'Codex' };

export function AccountsSection() {
  const [view, setView] = useState<AccountsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<AccountProvider | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  // Rename in place (2026-11-06): which row is being renamed, and its draft.
  const [renaming, setRenaming] = useState<{ provider: AccountProvider; id: string } | null>(null);
  const [draft, setDraft] = useState('');
  // Remove: the confirm names the threads pinned to the account (they revert to the default).
  const [removing, setRemoving] = useState<{ provider: AccountProvider; account: Account; threads: AccountThread[] } | null>(null);
  // The Codex account whose device-code sign-in shows now (a new one, or "Sign in again").
  const [codexSignIn, setCodexSignIn] = useState<string | null>(null);

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
    try { await api.accountsRemove(r.provider, r.account.id); await load(); } catch { setError('Could not remove the account.'); }
  };
  const rename = async () => {
    const r = renaming;
    if (!r) return;
    try { await api.accountsRename(r.provider, r.id, draft); setRenaming(null); await load(); } catch { setError('Could not rename the account.'); }
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

  const list = (provider: AccountProvider) => {
    const accounts = view?.[provider] ?? [];
    const def = view?.defaults[provider];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>{PROVIDER_TITLE[provider].toUpperCase()}</span>
        {accounts.map((a) => (
          <div key={a.id} data-testid={`account-${provider}-${a.id}`} style={{ ...row, padding: '8px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)' }}>
            <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {renaming?.provider === provider && renaming.id === a.id ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input aria-label="New name" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={a.isCli ? 'Name (empty restores the stock name)' : 'Name'}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void rename(); } if (e.key === 'Escape') setRenaming(null); }}
                    style={{ ...fieldInput, flex: 1 }} />
                  <button type="button" onClick={() => void rename()} style={solidBtn(true)}>Save</button>
                  <button type="button" onClick={() => setRenaming(null)} style={ghostBtn}>Cancel</button>
                </div>
              ) : (
                <span style={{ ...item, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label}</span>
              )}
              <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                {[a.email, a.plan, a.isCli ? 'the CLI’s own login' : null, a.signedIn === false ? 'not signed in yet' : null, a.threadCount ? `${a.threadCount} thread${a.threadCount === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || ' '}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {provider === 'codex' && !a.isCli && a.signedIn === false && codexSignIn !== a.id && (
                <button type="button" title="Sign in again" aria-label={`Sign in again to ${a.label}`} onClick={() => { setAdding(null); setCodexSignIn(a.id); }} style={{ ...ghostBtn, height: 28, padding: '0 9px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><SignIn size={13} />Sign in</button>
              )}
              <button type="button" title="Rename" aria-label={`Rename ${a.label}`} onClick={() => { setRenaming({ provider, id: a.id }); setDraft(a.isCli ? '' : a.label); }} style={{ ...ghostBtn, height: 28, width: 28, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)' }}><PencilSimple size={14} /></button>
              {def === a.id
                ? <span style={{ ...miniChip, color: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}>default</span>
                : <button type="button" title="Use for new threads" aria-label={`Make ${a.label} the default`} onClick={() => void setDefault(provider, a.id)} style={{ ...ghostBtn, height: 28, padding: '0 9px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Star size={13} />Default</button>}
              {!a.isCli && (
                <button type="button" title="Remove" aria-label={`Remove ${a.label}`} onClick={() => void askRemove(provider, a)} style={{ ...ghostBtn, height: 28, width: 28, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)' }}><Trash size={14} /></button>
              )}
            </div>
          </div>
        )).flatMap((row, i) => {
          const a = accounts[i];
          return provider === 'codex' && codexSignIn === a.id && adding !== 'codex'
            ? [row, <div key={`${a.id}-signin`} style={{ padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px dashed var(--color-border)' }}><CodexLogin accountId={a.id} onDone={codexSignInEnded} onCancel={codexSignInEnded} /></div>]
            : [row];
        })}
        {adding === provider ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px dashed var(--color-border)' }}>
            <input aria-label="Account name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={provider === 'claude' ? 'Name, like Work or Personal (optional)' : 'Name, like Work or Personal'} style={fieldInput} />
            {provider === 'claude' ? (
              <ClaudeLogin buttonLabel="Log in to the new Claude account" start={() => api.accountsClaudeLogin(label)} onDone={() => { setAdding(null); setLabel(''); void load(); }} />
            ) : codexSignIn ? (
              <CodexLogin accountId={codexSignIn} onDone={codexSignInEnded} onCancel={codexSignInEnded} />
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Dispatch shows a link and a code. Open the link on any device, sign in to ChatGPT, and enter the code.</div>
            )}
            {!(provider === 'codex' && codexSignIn) && (
              <div style={{ display: 'flex', gap: 8 }}>
                {provider === 'codex' && <button type="button" disabled={busy} onClick={() => void addCodex()} style={solidBtn(!busy)}>Add and sign in</button>}
                <button type="button" onClick={() => { setAdding(null); setLabel(''); }} style={ghostBtn}>Cancel</button>
              </div>
            )}
          </div>
        ) : (
          <div><button type="button" onClick={() => { setAdding(provider); setLabel(''); setCodexSignIn(null); }} style={{ ...ghostBtn, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} weight="bold" />Add {PROVIDER_TITLE[provider]} account</button></div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
        Each new thread picks one of these accounts, or uses the default. Usage shows every account.
        The CLI login is the one signed in on the daemon's computer; it cannot be removed here.
      </div>
      {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</div>}
      {list('claude')}
      <Divider />
      {list('codex')}
      <ConfirmModal
        open={!!removing}
        title={removing ? `Remove "${removing.account.label}"?` : ''}
        message={removing ? removeMessage(removing) : ''}
        confirmLabel="Remove"
        danger
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
