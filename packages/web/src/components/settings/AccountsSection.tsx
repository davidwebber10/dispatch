import { useEffect, useState } from 'react';
import { Star, Trash, Plus } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { Account, AccountProvider, AccountsView } from '../../api/types';
import { ClaudeLogin } from '../endless/ClaudeLogin';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useUI } from '../../stores/ui';
import { sectionLabel, row, item, fieldInput, solidBtn, ghostBtn, Divider, miniChip } from './ui';

/**
 * Settings → Accounts (multi-account spec 2026-11-06): the signed-in accounts under each harness,
 * which one new threads use by default, add one, remove one. `cli` is the CLI's own login on the
 * daemon's computer and is always there. A Claude account is added with the headless login (open
 * the page, paste the code). A Codex account gets its own folder and is signed in by a
 * "Sign in — Codex" thread that runs `codex login` under that folder.
 */
const PROVIDER_TITLE: Record<AccountProvider, string> = { claude: 'Claude', codex: 'Codex' };

export function AccountsSection() {
  const [view, setView] = useState<AccountsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<AccountProvider | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const projects = useProjects((s) => s.sessions);
  const activeId = useProjects((s) => s.activeId);

  const load = async () => {
    try { setView(await api.getAccounts()); setError(null); } catch { setError('Could not load the accounts. Is the daemon up to date?'); }
  };
  useEffect(() => { void load(); }, []);

  const setDefault = async (provider: AccountProvider, id: string) => {
    try { await api.accountsSetDefault(provider, id); await load(); } catch { setError('Could not change the default.'); }
  };
  const remove = async (provider: AccountProvider, a: Account) => {
    if (!window.confirm(`Remove the ${PROVIDER_TITLE[provider]} account "${a.label}"? Threads set to it will use the default account next time they start.`)) return;
    try { await api.accountsRemove(provider, a.id); await load(); } catch { setError('Could not remove the account.'); }
  };

  /** A new Codex account: make its folder, then open a sign-in thread under it in the active (or first) project. */
  const addCodex = async () => {
    const project = projects.find((p) => p.id === activeId) ?? projects[0];
    if (!project) { setError('Open a project first: the Codex sign-in runs in a thread there.'); return; }
    setBusy(true);
    try {
      const a = await api.accountsAddCodex(label);
      const t = await api.createTerminal(project.id, { type: 'shell', label: `Sign in — Codex (${a.label})`, config: { signIn: 'codex', accountId: a.id } });
      await useTabs.getState().loadTabs(project.id);
      useUI.getState().requestOpenThread({ sessionId: project.id, terminalId: t.id });
      setAdding(null); setLabel('');
      await load();
    } catch { setError('Could not start the Codex sign-in.'); }
    finally { setBusy(false); }
  };

  const list = (provider: AccountProvider) => {
    const accounts = view?.[provider] ?? [];
    const def = view?.defaults[provider];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>{PROVIDER_TITLE[provider].toUpperCase()}</span>
        {accounts.map((a) => (
          <div key={a.id} data-testid={`account-${provider}-${a.id}`} style={{ ...row, padding: '8px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)' }}>
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ ...item, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label}</span>
              <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                {[a.email, a.plan, a.isCli ? 'the CLI’s own login' : null, a.signedIn === false ? 'not signed in yet' : null].filter(Boolean).join(' · ') || ' '}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {def === a.id
                ? <span style={{ ...miniChip, color: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}>default</span>
                : <button type="button" title="Use for new threads" aria-label={`Make ${a.label} the default`} onClick={() => void setDefault(provider, a.id)} style={{ ...ghostBtn, height: 28, padding: '0 9px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Star size={13} />Default</button>}
              {!a.isCli && (
                <button type="button" title="Remove" aria-label={`Remove ${a.label}`} onClick={() => void remove(provider, a)} style={{ ...ghostBtn, height: 28, width: 28, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)' }}><Trash size={14} /></button>
              )}
            </div>
          </div>
        ))}
        {adding === provider ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px dashed var(--color-border)' }}>
            <input aria-label="Account name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={provider === 'claude' ? 'Name, like Work or Personal (optional)' : 'Name, like Work or Personal'} style={fieldInput} />
            {provider === 'claude' ? (
              <ClaudeLogin buttonLabel="Log in to the new Claude account" start={() => api.accountsClaudeLogin(label)} onDone={() => { setAdding(null); setLabel(''); void load(); }} />
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>A "Sign in — Codex" thread opens in the project. Finish the login there; the account is ready when it says so.</div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              {provider === 'codex' && <button type="button" disabled={busy} onClick={() => void addCodex()} style={solidBtn(!busy)}>Open the sign-in thread</button>}
              <button type="button" onClick={() => { setAdding(null); setLabel(''); }} style={ghostBtn}>Cancel</button>
            </div>
          </div>
        ) : (
          <div><button type="button" onClick={() => { setAdding(provider); setLabel(''); }} style={{ ...ghostBtn, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} weight="bold" />Add {PROVIDER_TITLE[provider]} account</button></div>
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
    </div>
  );
}
