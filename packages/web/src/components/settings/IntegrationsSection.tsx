import { useCallback, useEffect, useRef, useState } from 'react';
import { DownloadSimple, Globe, Terminal, UploadSimple } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { Integration, AddIntegrationInput, IntegrationsExport } from '../../api/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { describeCreator } from '../../lib/creator';
import { useSecrets } from '../../stores/secrets';
import { ConfirmModal } from '../common/ConfirmModal';
import { Segmented } from '../common/Segmented';
import {
  ghostBtn, solidBtn, fieldFor, Sheet, Toggle,
  SettingsPage, SettingsGroup, SettingsRow, SettingsSubPage, EmptyState,
} from './ui';

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11.5 };
const oneLine: React.CSSProperties = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const codeBlock: React.CSSProperties = { ...mono, color: 'var(--color-text-body)', overflowWrap: 'anywhere', lineHeight: 1.5 };
const errText: React.CSSProperties = { fontSize: 12, color: 'var(--color-status-red)', padding: '0 4px' };

function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}

/** The one-line summary under a name: the URL, or the command line. */
const target = (i: Integration): string => (i.type === 'remote' ? i.url ?? '' : `${i.command ?? ''} ${i.args.join(' ')}`.trim());
/** A header or env value shows only when it is a ${NAME} reference; a literal value may be a secret from before the check. */
const shownValue = (v: string): string | null => (/\$\{[A-Za-z0-9_]+\}/.test(v) ? v : null);

/**
 * A sub-page with a phone history entry (local primitive, 2026-11-07; promote with Plugins' copy in
 * stores/mobileNav.ts). On the phone, opening pushes an entry above the section, so the app
 * header's back and an edge swipe close the page; on the desktop it is plain state.
 */
function useSubPage(section: string, isMobile: boolean) {
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (!isMobile) return;
    const onPop = (e: PopStateEvent) => {
      const s = e.state as { settingsSection?: string; subDetail?: string } | null;
      setOpenId(s?.settingsSection === section && s.subDetail ? s.subDetail : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isMobile, section]);
  const open = (id: string) => {
    if (isMobile) {
      const depth = ((history.state as { depth?: number } | null)?.depth ?? 0) + 1;
      history.pushState({ nav: 1, settingsSection: section, subDetail: id, depth }, '', location.pathname);
    }
    setOpenId(id);
  };
  const close = () => {
    if (isMobile && (history.state as { subDetail?: string } | null)?.subDetail) history.back();
    else setOpenId(null);
  };
  return { openId, open, close };
}

/** A labeled field in the add sheet: the label, then the input, then one quiet hint. */
function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => React.ReactNode }) {
  const id = `integration-field-${label.toLowerCase()}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label htmlFor={id} style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{label}</label>
      {children(id)}
      {hint && <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{hint}</span>}
    </div>
  );
}

/**
 * Settings → Integrations (redesigned 2026-11-07, docs/design/settings-layout.md): one group of MCP
 * integrations (on ones first), each a row with a switch that opens its own page (connection, who
 * added it, Remove). The add form is a sheet; Export and Import sit in a Backup group.
 */
export function IntegrationsSection() {
  const isMobile = useIsMobile();
  const [list, setList] = useState<Integration[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [sheetErr, setSheetErr] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [removing, setRemoving] = useState<Integration | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const page = useSubPage('integrations', isMobile);

  const doppler = useSecrets((s) => s.status);

  const reload = useCallback(async () => {
    try { setList((await api.listIntegrations()).integrations); }
    catch { setErr('Could not reach Dispatch.'); }
    setLoaded(true);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  // Status only: the store's loadStatus() would also pull every secret value into the page.
  useEffect(() => { api.getSecretsStatus().then((status) => useSecrets.setState({ status })).catch(() => {}); }, []);
  const dopplerOn = !!doppler?.connected && doppler.enabled;
  const dopplerWhere = doppler?.project && doppler?.config ? ` (${doppler.project}/${doppler.config})` : '';

  const canAdd = !busy && /^[a-zA-Z0-9_-]+$/.test(name.trim()) && (advanced ? !!command.trim() : /^https?:\/\//.test(url.trim()));
  const ordered = [...list.filter((i) => i.enabled), ...list.filter((i) => !i.enabled)];
  const current = page.openId ? list.find((i) => i.id === page.openId) ?? null : null;

  function openSheet() { setSheetErr(''); setSheet(true); }
  async function add() {
    if (!canAdd) return;
    setBusy(true); setSheetErr('');
    const inputData: AddIntegrationInput = advanced
      ? { type: 'stdio', name: name.trim(), command: command.trim(), args: args.split(' ').filter(Boolean), env: parseKV(env) }
      : { type: 'remote', name: name.trim(), url: url.trim(), headers: parseKV(headers) };
    try {
      await api.addIntegration(inputData);
      setName(''); setUrl(''); setHeaders(''); setCommand(''); setArgs(''); setEnv('');
      setSheet(false);
      await reload();
    } catch (e) {
      // A typed-in secret is refused with advice to use a ${NAME} reference: show that text, not the generic line.
      const detail = e instanceof Error ? e.message.split(' — ').slice(1).join(' — ') : '';
      setSheetErr(/looks like a secret/.test(detail) ? detail : 'Could not add. Check that the name is unique and the inputs are valid.');
    }
    setBusy(false);
  }
  async function toggle(i: Integration) { if (busy) return; setBusy(true); setErr(''); try { await api.setIntegrationEnabled(i.id, !i.enabled); await reload(); } catch { setErr('Could not update.'); } setBusy(false); }
  async function remove(i: Integration) {
    setRemoving(null);
    if (busy) return;
    setBusy(true); setErr('');
    try { await api.removeIntegration(i.id); page.close(); await reload(); } catch { setErr('Could not remove.'); }
    setBusy(false);
  }

  async function doExport() {
    setNote('');
    try {
      const doc = await api.exportIntegrations();
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'integrations.json'; a.click(); URL.revokeObjectURL(a.href);
    } catch { setErr('Export failed: could not reach Dispatch.'); }
  }
  async function doImport(file: File) {
    setErr(''); setNote('');
    try {
      const doc = JSON.parse(await file.text()) as IntegrationsExport;
      const r = await api.importIntegrations(doc);
      await reload();
      setNote(`Imported ${r.added.length}, skipped ${r.skipped.length}.${r.reasons?.[0] ? ` ${r.reasons[0].name}: ${r.reasons[0].reason}` : ''}`);
    } catch { setErr('Import failed: the file is not a valid export.'); }
  }

  const removeConfirm = (
    <ConfirmModal open={removing !== null} danger title={`Remove ${removing?.name ?? 'this integration'}?`} confirmLabel="Remove integration"
      message="New agent threads no longer get its tools. You can add it again later."
      onConfirm={() => { if (removing) void remove(removing); }} onCancel={() => setRemoving(null)} />
  );

  // One integration's own page.
  if (current) {
    const remote = current.type === 'remote';
    const pairs = Object.entries(remote ? current.headers : current.env);
    return (
      <div data-testid="integration-page">
        <SettingsSubPage title={current.name} icon={remote ? Globe : Terminal} backLabel="Integrations" onBack={isMobile ? undefined : page.close}
          subtitle={<>{remote ? 'Remote' : 'Local command'} · <span data-testid="integration-creator">Added by {describeCreator(current.createdBy)}</span></>}
          description={remote ? 'A server on the web that Dispatch reaches by its URL.' : 'A program that Dispatch starts on this Mac for each thread.'}>
          <SettingsGroup>
            <SettingsRow label="On" hint="Every new agent thread gets its tools."
              control={<Toggle on={current.enabled} label={`${current.name} on`} onClick={() => void toggle(current)} />} />
          </SettingsGroup>
          <SettingsGroup title="Connection">
            <SettingsRow label={remote ? 'URL' : 'Command'}><div style={codeBlock}>{target(current)}</div></SettingsRow>
            {pairs.length > 0 && (
              <SettingsRow label={remote ? 'Headers' : 'Environment'} hint="Only ${NAME} references show here.">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {pairs.map(([k, v]) => {
                    const shown = shownValue(v);
                    return (
                      <div key={k} style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                        <span style={{ ...mono, color: 'var(--color-text-secondary)', flexShrink: 0 }}>{k}</span>
                        {shown ? <span style={{ ...codeBlock, minWidth: 0 }}>{shown}</span> : <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Set</span>}
                      </div>
                    );
                  })}
                </div>
              </SettingsRow>
            )}
          </SettingsGroup>
          {err && <div style={errText}>{err}</div>}
          <SettingsGroup>
            <SettingsRow label="Remove integration" danger onClick={() => setRemoving(current)} />
          </SettingsGroup>
        </SettingsSubPage>
        {removeConfirm}
      </div>
    );
  }

  const addButton = (label: string) => <button type="button" style={ghostBtn} onClick={openSheet}>{label}</button>;
  const footer = (
    <>
      <div>{'Write ${NAME} in a header or env value. '}{`Dispatch reads NAME from Doppler${dopplerWhere} when the integration starts; the value never appears in a command line or a config file.`}</div>
      {doppler && !dopplerOn && (
        <div style={{ marginTop: 4, color: 'var(--color-status-yellow)' }}>
          {doppler.connected ? 'Doppler is turned off' : 'Doppler is not connected'}{', so ${NAME} will not resolve from it. Connect Doppler in Settings → Secrets.'}
        </div>
      )}
    </>
  );

  return (
    <SettingsPage intro="MCP integrations give every agent thread more tools (Claude Code, Codex, Grok, OpenCode). They are the same on every device.">
      {!loaded ? null : list.length === 0 ? (
        <EmptyState action={addButton('Add an integration…')}>No integrations yet. Add one to give every agent thread its tools.</EmptyState>
      ) : (
        <SettingsGroup title="Integrations" action={addButton('Add…')} footer={footer}>
          {ordered.map((i) => (
            <div key={i.id} data-testid="integration-row" data-name={i.name} style={{ opacity: i.enabled ? 1 : 0.6 }}>
              <SettingsRow icon={i.type === 'remote' ? Globe : Terminal} label={i.name} ariaLabel={`${i.name}, ${i.enabled ? 'on' : 'off'}`}
                hint={<span style={{ ...oneLine, ...mono }}>{target(i)}</span>}
                control={<Toggle on={i.enabled} label={`${i.name} on`} onClick={() => void toggle(i)} />}
                onClick={() => page.open(i.id)} />
            </div>
          ))}
        </SettingsGroup>
      )}
      {err && <div style={errText}>{err}</div>}

      <SettingsGroup title="Backup" footer={note || undefined}>
        <SettingsRow icon={DownloadSimple} label="Export" ariaLabel="Export integrations" hint="Save every integration to a JSON file." onClick={() => void doExport()} />
        <SettingsRow icon={UploadSimple} label="Import" ariaLabel="Import integrations" hint="Add the integrations from an exported file." onClick={() => fileRef.current?.click()} />
      </SettingsGroup>
      <input ref={fileRef} data-testid="integrations-import-file" type="file" accept="application/json" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ''; }} />

      <Sheet open={sheet} onClose={() => setSheet(false)} title="Add an integration">
        <Segmented ariaLabel="Kind of integration" value={advanced ? 'local' : 'remote'} onChange={(v) => setAdvanced(v === 'local')}
          options={[
            { value: 'remote', label: 'Remote', hint: 'A server on the web, reached by its URL.' },
            { value: 'local', label: 'Local command', hint: 'A program that Dispatch starts on this Mac.' },
          ]} />
        <Field label="Name" hint="Letters, digits, _ and -.">
          {(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="linear" autoComplete="off" style={{ ...fieldFor(isMobile), width: '100%' }} />}
        </Field>
        {!advanced ? (
          <>
            <Field label="URL">
              {(id) => <input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" autoComplete="off" style={{ ...fieldFor(isMobile), ...mono, width: '100%' }} />}
            </Field>
            <Field label="Headers" hint="Optional. One per line, as Name=value. Use ${NAME} for a secret.">
              {(id) => <textarea id={id} value={headers} onChange={(e) => setHeaders(e.target.value)} rows={2} placeholder="Authorization=Bearer ${MY_TOKEN}"
                style={{ ...fieldFor(isMobile), ...mono, width: '100%', height: 'auto', minHeight: 56, padding: '7px 9px', resize: 'vertical' }} />}
            </Field>
          </>
        ) : (
          <>
            <Field label="Command">
              {(id) => <input id={id} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" autoComplete="off" style={{ ...fieldFor(isMobile), ...mono, width: '100%' }} />}
            </Field>
            <Field label="Arguments" hint="Separated by spaces.">
              {(id) => <input id={id} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @scope/mcp-server" autoComplete="off" style={{ ...fieldFor(isMobile), ...mono, width: '100%' }} />}
            </Field>
            <Field label="Environment" hint="Optional. One per line, as NAME=value. Use ${NAME} for a secret.">
              {(id) => <textarea id={id} value={env} onChange={(e) => setEnv(e.target.value)} rows={2} placeholder="ROOT=/tmp"
                style={{ ...fieldFor(isMobile), ...mono, width: '100%', height: 'auto', minHeight: 56, padding: '7px 9px', resize: 'vertical' }} />}
            </Field>
          </>
        )}
        {sheetErr && <div style={{ fontSize: 12, color: 'var(--color-status-red)' }}>{sheetErr}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={() => setSheet(false)} style={{ ...ghostBtn, flex: 1, height: isMobile ? 40 : 32 }}>Cancel</button>
          <button type="button" aria-label="Add integration" onClick={() => void add()} disabled={!canAdd} style={{ ...solidBtn(canAdd), flex: 1, height: isMobile ? 40 : 32 }}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
      </Sheet>
      {removeConfirm}
    </SettingsPage>
  );
}
