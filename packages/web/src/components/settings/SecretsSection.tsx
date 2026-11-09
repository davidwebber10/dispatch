import { useEffect, useRef, useState } from 'react';
import { Eye, EyeSlash, Copy, Check, Trash, Plus, ShieldWarning } from '@phosphor-icons/react';
import type { DopplerTokenScope } from '../../api/types';
import { useSecrets } from '../../stores/secrets';
import { api } from '../../api/client';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ghostBtn, solidBtn, fieldFor, Toggle, IconGhost, Sheet, StatusMark, SettingsPage, SettingsGroup, SettingsRow } from './ui';
import { Select } from '../common/Select';
import { ConfirmModal } from '../common/ConfirmModal';

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const errText: React.CSSProperties = { fontSize: 12, color: 'var(--color-status-red)', padding: '0 4px' };
const INTRO = 'Dispatch syncs environment variables from Doppler into your sessions. The token stays on this daemon.';

/**
 * Settings → Secrets (redesigned 2026-11-07, docs/design/settings-layout.md): a Doppler group (the
 * token and the project/config picker, or the connection and the read-only switch), a Variables
 * group with a row per secret (values masked until revealed, fetched one at a time), and
 * Disconnect at the bottom. Add opens a sheet; delete and disconnect ask first.
 */
export function SecretsSection() {
  const isMobile = useIsMobile();
  const status = useSecrets((s) => s.status);
  const secrets = useSecrets((s) => s.secrets);
  const projects = useSecrets((s) => s.projects);
  const configs = useSecrets((s) => s.configs);

  const [token, setToken] = useState('');
  const [project, setProject] = useState('');
  const [config, setConfig] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  // Values are fetched one at a time, on an explicit reveal or copy; the list carries names only.
  const [values, setValues] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [synced, setSynced] = useState(false);
  const [copied, setCopied] = useState('');
  const [sheet, setSheet] = useState(false);
  // The secret a delete is asking about, and whether Disconnect is asking.
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  // Set after a scope change in this visit: the change reaches a thread at its next start.
  const [scopeChanged, setScopeChanged] = useState(false);
  // Bumped whenever the fetched values are dropped: a reveal or copy that was already in flight
  // belongs to the old generation, and its answer is thrown away.
  const generation = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => { void useSecrets.getState().loadStatus(); }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  // A fetched value belongs to one project/config and one moment: drop them all when the list reloads
  // (an add, a delete, a re-sync) or the config changes, so reveal and copy never return a stale value.
  useEffect(() => { generation.current += 1; setValues({}); setReveal({}); }, [secrets, status?.project, status?.config]);
  useEffect(() => {
    if (status?.project) { setProject(status.project); void useSecrets.getState().loadConfigs(status.project); }
    if (status?.config) setConfig(status.config);
  }, [status?.project, status?.config]);

  const connected = !!status?.connected;
  const readOnly = !!status?.readOnly;
  // A daemon from before the scope existed sends none: every thread gets the token there.
  const tokenScope: DopplerTokenScope = status?.tokenScope === 'opted-in' ? 'opted-in' : 'all';
  const canAdd = !!newName.trim() && !!newValue.trim() && !readOnly && !busy;
  const filtered = query ? secrets.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())) : secrets;
  const allShown = filtered.length > 0 && filtered.every((s) => reveal[s.name]);

  async function connect() {
    if (!token.trim() || busy) return;
    setBusy(true); setErr('');
    try {
      await useSecrets.getState().connect({ token: token.trim(), project, config, enabled: true, readOnly });
      await useSecrets.getState().loadProjects();
    } catch { setErr('Could not connect. Check your Doppler token.'); }
    setBusy(false);
  }

  async function pickProject(p: string) {
    setProject(p); setConfig('');
    try { await useSecrets.getState().loadConfigs(p); } catch { setErr('Could not load configs.'); }
  }

  async function pickConfig(c: string) {
    setConfig(c);
    if (!token.trim()) return;
    setBusy(true); setErr('');
    try { await useSecrets.getState().connect({ token: token.trim(), project, config: c, enabled: true, readOnly }); }
    catch { setErr('Could not save selection.'); }
    setBusy(false);
  }

  async function toggleReadOnly() {
    if (!status) return;
    setBusy(true); setErr('');
    // token left blank: daemon keeps the stored token, updates only flags.
    try { await useSecrets.getState().connect({ token: '', project: status.project ?? '', config: status.config ?? '', enabled: status.enabled, readOnly: !readOnly }); }
    catch { setErr('Could not update read-only.'); }
    setBusy(false);
  }

  /** Which threads get DOPPLER_TOKEN in their environment (W1-C). Only the scope is sent. */
  async function changeScope(scope: DopplerTokenScope) {
    if (busy || scope === tokenScope) return;
    setBusy(true); setErr('');
    try { await useSecrets.getState().setTokenScope(scope); setScopeChanged(true); }
    catch { setErr('Could not change the token scope.'); }
    setBusy(false);
  }

  async function disconnect() {
    setBusy(true); setErr('');
    try { await useSecrets.getState().disconnect(); setToken(''); setProject(''); setConfig(''); }
    catch { setErr('Could not disconnect.'); }
    setBusy(false);
  }

  async function fetchValues(names: string[]): Promise<Record<string, string>> {
    const gen = generation.current;
    const missing = names.filter((n) => values[n] === undefined);
    const got: Record<string, string> = {};
    try {
      await Promise.all(missing.map(async (n) => { got[n] = await api.getSecretValue(n); }));
    } catch { setErr('Could not load value.'); }
    if (gen !== generation.current) return {}; // the list or config changed while this was in flight
    if (Object.keys(got).length) setValues((v) => ({ ...v, ...got }));
    return { ...values, ...got };
  }

  async function toggleOne(name: string) {
    if (!reveal[name]) {
      const got = await fetchValues([name]);
      if (got[name] === undefined) return;
    }
    setReveal((r) => ({ ...r, [name]: !r[name] }));
  }

  async function toggleAll() {
    if (allShown) { setReveal({}); return; }
    const names = filtered.map((s) => s.name);
    const got = await fetchValues(names);
    if (names.some((n) => got[n] === undefined)) return;
    setReveal(Object.fromEntries(names.map((n) => [n, true])));
  }

  async function resync() {
    if (busy) return;
    setErr('');
    try {
      generation.current += 1; setValues({}); setReveal({});
      await useSecrets.getState().loadSecrets();
      setSynced(true);
      timers.current.push(setTimeout(() => setSynced(false), 1500));
    } catch { setErr('Could not re-sync.'); }
  }

  async function add() {
    if (!canAdd) return;
    setBusy(true); setErr('');
    try { await useSecrets.getState().setSecret(newName.trim(), newValue); setNewName(''); setNewValue(''); setSheet(false); }
    catch { setErr('Could not save secret.'); }
    setBusy(false);
  }

  async function remove(name: string) {
    setErr('');
    try { await useSecrets.getState().deleteSecret(name); } catch { setErr('Could not delete secret.'); }
  }

  async function copyValue(name: string) {
    const v = (await fetchValues([name]))[name];
    if (v === undefined) return;
    void navigator.clipboard?.writeText(v);
    setCopied(name);
    timers.current.push(setTimeout(() => setCopied((c) => (c === name ? '' : c)), 1200));
  }

  const actions = (name: string) => {
    const shown = !!reveal[name];
    return (
      <span style={{ display: 'flex', gap: 2 }}>
        <IconGhost title={shown ? 'Hide value' : 'Reveal value'} active={shown} onClick={() => void toggleOne(name)}>
          {shown ? <EyeSlash size={15} /> : <Eye size={15} />}
        </IconGhost>
        <IconGhost title="Copy value" active={copied === name} onClick={() => void copyValue(name)}>
          {copied === name ? <Check size={15} /> : <Copy size={15} />}
        </IconGhost>
        {!readOnly && <IconGhost title="Delete secret" danger onClick={() => setDeleting(name)}><Trash size={15} /></IconGhost>}
      </span>
    );
  };

  const valueLine = (name: string) => (reveal[name] && values[name] !== undefined
    ? <span style={{ ...mono, display: 'block', fontSize: 11.5, color: 'var(--color-text-secondary)' }}>{values[name]}</span>
    : <span style={{ display: 'block', color: 'var(--color-text-tertiary)', letterSpacing: '2px', fontSize: 10, overflow: 'hidden', whiteSpace: 'nowrap' }}>••••••••••••</span>);

  const where = status?.project ? `${status.project}${status.config ? ` / ${status.config}` : ''}` : '';
  const field = { ...fieldFor(isMobile), width: '100%' };

  if (!connected) {
    // The connect flow: a verified token loads the projects; a project loads its configs; the
    // config pick saves the connection (the daemon calls it connected once all three are set).
    return (
      <SettingsPage intro={INTRO}>
        <SettingsGroup title="Doppler" footer={projects.length > 0 ? 'Token accepted. Pick a project and a config to finish.' : undefined}>
          <SettingsRow label="Service token" hint="Make one in Doppler for the project and config you want. It starts with dp.st.">
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="password" aria-label="Doppler service token" value={token} onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} placeholder="dp.st.…" autoComplete="off"
                style={{ ...field, flex: 1, fontFamily: 'var(--font-mono)' }} />
              <button onClick={() => void connect()} disabled={!token.trim() || busy} style={{ ...solidBtn(!!token.trim() && !busy), height: isMobile ? 36 : 30 }}>Connect</button>
            </div>
          </SettingsRow>
          {projects.length > 0 && (
            <SettingsRow label="Project" control={
              <Select ariaLabel="Doppler project" value={project} onChange={(v) => void pickProject(v)} placeholder="Select…" style={{ width: 170 }}
                options={projects.map((p) => ({ value: p.slug, label: p.name }))} />} />
          )}
          {configs.length > 0 && (
            <SettingsRow label="Config" control={
              <Select ariaLabel="Doppler config" value={config} onChange={(v) => void pickConfig(v)} placeholder="Select…" style={{ width: 170 }}
                options={configs.map((c) => ({ value: c.name, label: c.name }))} />} />
          )}
        </SettingsGroup>
        {err && <div style={errText}>{err}</div>}
      </SettingsPage>
    );
  }

  const resyncBtn = (
    <button onClick={() => void resync()} disabled={busy} style={{ ...ghostBtn, display: 'flex', alignItems: 'center', gap: 5, color: synced ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
      {synced ? <><Check size={13} weight="bold" />Synced</> : 'Re-sync'}
    </button>
  );
  const count = `${secrets.length} variable${secrets.length === 1 ? '' : 's'}`;

  return (
    <SettingsPage intro={INTRO}>
      <SettingsGroup title="Doppler">
        <SettingsRow label="Connection" hint={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{where}</span>}
          control={<StatusMark tone="accent">Connected</StatusMark>} />
        <SettingsRow label="Read-only" hint={readOnly ? 'Values come from Doppler; nothing on this daemon can change them.' : 'Edits allowed. Changes write to Doppler.'}
          control={<Toggle on={readOnly} label="Read-only" disabled={busy} onClick={() => void toggleReadOnly()} />} />
        <SettingsRow label="Give the Doppler token to"
          hint={<>
            {tokenScope === 'all'
              ? 'Every thread has DOPPLER_TOKEN in its environment.'
              : 'A thread has DOPPLER_TOKEN only after you turn it on in the thread menu (More). The Doppler tools and the integrations work in every thread.'}
            {scopeChanged && <span style={{ display: 'block' }}>The change takes effect when a thread next starts.</span>}
          </>}
          control={<Select ariaLabel="Give the Doppler token to" value={tokenScope} disabled={busy} onChange={(v) => void changeScope(v as DopplerTokenScope)} style={{ width: isMobile ? 190 : 230 }}
            options={[{ value: 'all', label: 'Every thread' }, { value: 'opted-in', label: 'Only threads that I turn on' }]} />} />
        {tokenScope === 'all' && (
          <div key="scope-advice" data-testid="token-scope-advice" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '10px 12px', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
            <ShieldWarning size={16} style={{ flexShrink: 0, color: 'var(--color-status-amber, var(--color-text-secondary))' }} />
            <span style={{ flex: '1 1 220px', minWidth: 0 }}>Every thread can read the Doppler token. Most threads need only the Doppler tools.</span>
            <button type="button" onClick={() => void changeScope('opted-in')} disabled={busy} style={{ ...ghostBtn, height: isMobile ? 36 : 28, flexShrink: 0 }}>Limit to threads that I turn on</button>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Variables" action={resyncBtn}
        footer={readOnly ? <>{count}. Values sync from Doppler. Turn off read-only to add, edit, or delete variables.</> : count}>
        {secrets.length > 0 && (
          <div key="filter" style={{ display: 'flex', gap: 8, padding: '8px 12px', alignItems: 'center' }}>
            <input aria-label="Filter variables" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter variables" style={{ ...field, flex: 1 }} />
            <button onClick={() => void toggleAll()} style={{ ...ghostBtn, height: isMobile ? 36 : 30 }}>{allShown ? 'Hide all values' : 'Reveal all values'}</button>
          </div>
        )}
        {filtered.map((s) => (
          <div key={s.name} data-testid="secret-row">
            <SettingsRow label={<span style={{ ...mono, display: 'block', color: 'var(--color-text-primary)' }}>{s.name}</span>} hint={valueLine(s.name)} control={actions(s.name)} />
          </div>
        ))}
        {filtered.length === 0 && secrets.length > 0 && <div key="none" style={{ padding: '14px 12px', fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>No variables match “{query}”.</div>}
        {secrets.length === 0 && <div key="empty" style={{ padding: '14px 12px', fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>No secrets in this config.</div>}
        {!readOnly && <SettingsRow key="add" icon={Plus} label="Add variable" onClick={() => setSheet(true)} />}
      </SettingsGroup>
      {err && <div style={errText}>{err}</div>}

      <SettingsGroup footer="Dispatch forgets the token. Your secrets stay in Doppler.">
        <SettingsRow label="Disconnect Doppler" danger onClick={() => setConfirmDisconnect(true)} />
      </SettingsGroup>

      <Sheet open={sheet} onClose={() => setSheet(false)} title="Add variable">
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          Name
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="API_KEY" autoComplete="off"
            style={{ ...field, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          Value
          <input value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} autoComplete="off"
            style={{ ...field, fontFamily: 'var(--font-mono)' }} />
        </label>
        <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Saves to Doppler in {where}.</span>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button onClick={() => setSheet(false)} style={{ ...ghostBtn, flex: 1, height: isMobile ? 40 : 32 }}>Cancel</button>
          <button aria-label="Save variable" onClick={() => void add()} disabled={!canAdd} style={{ ...solidBtn(canAdd), flex: 1, height: isMobile ? 40 : 32 }}>{busy ? 'Saving…' : 'Add'}</button>
        </div>
      </Sheet>

      <ConfirmModal open={deleting !== null} danger title={`Delete ${deleting ?? 'this secret'}?`} confirmLabel="Delete secret"
        message={`This deletes it in Doppler (${status?.project ?? ''}/${status?.config ?? ''}), for every app that reads that config.`}
        onConfirm={() => { const n = deleting; setDeleting(null); if (n) void remove(n); }} onCancel={() => setDeleting(null)} />
      <ConfirmModal open={confirmDisconnect} danger title="Disconnect Doppler?" confirmLabel="Disconnect"
        message="Dispatch forgets the token. Your secrets stay in Doppler, but new sessions no longer get them."
        onConfirm={() => { setConfirmDisconnect(false); void disconnect(); }} onCancel={() => setConfirmDisconnect(false)} />
    </SettingsPage>
  );
}
