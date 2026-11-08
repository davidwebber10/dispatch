import { useEffect, useRef, useState } from 'react';
import { CaretRight, Copy as CopyIcon } from '@phosphor-icons/react';
import { api, readFileText } from '../../api/client';
import type { PluginRow, Marketplace, CatalogEntry, MarketVersion } from '../../api/types';
import { usePluginRegistry, PROMOTED_MAX, type PluginStatus, type PluginView } from '../../plugins/registry';
import { isSafeMode, setSafeMode, reloadPlugin } from '../../plugins/host';
import { pluginIcon } from '../../plugins/sdk';
import { ConfirmModal } from '../common/ConfirmModal';
import { Modal } from '../common/Modal';
import { copyText } from '../../lib/clipboard';
import { useHint } from '../../stores/hint';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMobileNav, openSettingsPluginPage, closeSettingsPluginPage } from '../../stores/mobileNav';
import { sectionLabel, ghostBtn, solidBtn, fieldInput, Toggle, ToneDot, TONE_VAR, IconTile, SettingsSubPage, type Tone } from './ui';
import { Select } from '../common/Select';

const note: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-text-tertiary)' };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const radioLabel: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, color: 'var(--color-text-primary)', cursor: 'pointer' };
/** The grouped card every list on this page sits in: the same shape as the phone's Settings list. */
const group: React.CSSProperties = { background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' };
const groupRow = (i: number): React.CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', minWidth: 0, borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' });
const stack: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };
const title: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const oneLine: React.CSSProperties = { display: 'block', marginTop: 2, fontSize: 12, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const body: React.CSSProperties = { fontSize: 13, color: 'var(--color-text-body)' };
const mono: React.CSSProperties = { font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', overflowWrap: 'anywhere' };
const buttons: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' };

/** Plain words for each permission id (docs/plugins.md lists the same ids). An unknown id shows as it is. */
export const PERMISSION_WORDS: Record<string, string> = {
  'read:projects': 'Read the project list',
  'read:threads': 'Read threads',
  'read:ledger': 'Read project ledgers',
  'write:ledger': 'Add to project ledgers',
  'read:prompts': 'Read your prompts',
  'message:threads': 'Send messages to threads',
  'spawn:threads': 'Start threads',
  'notify': 'Show notifications and hints',
  'storage': 'Keep its own data and settings',
  'threads:read-storage': 'Let threads read its data',
  'threads:write-storage': 'Let threads change its data',
  'threads:call-worker': 'Let threads call its worker',
  'model:assist': 'Use a model on your behalf',
  'read:usage': 'Read usage',
  'read:analytics': 'Read usage analytics',
  'notify:push': 'Send push notifications',
  'network': 'Connect to the internet',
};

const kTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** The meter line: calls, failures, tokens and the known cost over the last days (coach spec section 4.5). */
export function assistLine(a: NonNullable<PluginRow['assist']>): string {
  const failed = a.failed ? ` (${a.failed} failed)` : '';
  const cost = a.costUsd ? ` · $${a.costUsd.toFixed(2)}` : '';
  return `Model calls, ${a.days ?? 7} days: ${a.calls}${failed} · ${kTokens(a.inputTokens)} in · ${kTokens(a.outputTokens)} out tokens${cost}`;
}

/** "Worker running · 2 restarts", "Worker crashed · exit 1 · 10 restarts". The pid is under Developer. */
function workerLabel(w: PluginRow['workerStats']): string {
  if (!w) return 'Worker stopped';
  const restarts = w.restarts > 0 ? ` · ${w.restarts} restart${w.restarts === 1 ? '' : 's'}` : '';
  if (w.state === 'running') return `Worker running${restarts}`;
  if (w.state === 'crashed') return `Worker crashed${w.lastExit ? ` · ${w.lastExit.signal ? `signal ${w.lastExit.signal}` : `exit ${w.lastExit.code ?? '?'}`}` : ''}${restarts}`;
  if (w.state === 'backoff') return `Worker restarting${restarts}`;
  return 'Worker stopped';
}
const workerTone = (w: PluginRow['workerStats']): Tone => (w?.state === 'running' ? 'accent' : w?.state === 'crashed' ? 'red' : w?.state === 'backoff' ? 'yellow' : 'muted');

/** The load error, from the daemon's row or the host's load status. */
const loadError = (r: PluginRow, s: PluginStatus | undefined): string | undefined => r.error ?? (r.enabled && s?.state === 'error' ? s.error ?? 'The plugin failed to load.' : undefined);

/** The list row's one status mark, only when something needs attention; null when all is well or the plugin is off. */
export function attentionOf(r: PluginRow, s: PluginStatus | undefined): { label: string; tone: Tone } | null {
  if (r.error) return { label: 'Error', tone: 'red' };
  if (!r.enabled) return null;
  if (s?.state === 'error') return { label: 'Error', tone: 'red' };
  if (r.worker) {
    const st = r.workerStats?.state;
    if (st === 'crashed') return { label: 'Worker crashed', tone: 'red' };
    if (st === 'backoff') return { label: 'Worker restarting', tone: 'yellow' };
    if (st !== 'running') return { label: 'Worker stopped', tone: 'yellow' };
  }
  if (r.marketplaceGone) return { label: 'Marketplace removed', tone: 'yellow' };
  if (r.update) return { label: 'Update available', tone: 'accent' };
  return null;
}

const Dot = ToneDot;

/** A small heading over a group card. */
function GroupLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 30, padding: '0 4px' }}>
      <span style={sectionLabel}>{children}</span>
      {action}
    </div>
  );
}

/**
 * Settings → Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.5), redesigned
 * 2026-11-07: a calm list, one row per plugin (icon, name, one line, a status mark only when
 * something needs attention, an on/off switch). A tap on a row opens the plugin's own page:
 * header, switches, permissions in plain words, status, actions, and a collapsed Developer part.
 * On the phone the page covers the screen with the same back header as the other pushed screens.
 */
export function PluginsSection() {
  const isMobile = useIsMobile();
  const manifests = usePluginRegistry((s) => s.manifests);
  const status = usePluginRegistry((s) => s.status);
  const views = usePluginRegistry((s) => s.views);
  const promoted = usePluginRegistry((s) => s.promoted);
  // The open plugin's page. On a phone it is a screen of the Settings tab, kept in stores/mobileNav
  // with a history entry, so back closes it and the tab bar can bring it back (2026-11-07).
  const [deskOpenId, setDeskOpenId] = useState<string | null>(null);
  const phoneOpenId = useMobileNav((s) => s.settingsPluginId);
  const openId = isMobile ? phoneOpenId : deskOpenId;
  const setOpenId = (id: string | null) => {
    if (!isMobile) setDeskOpenId(id);
    else if (id) openSettingsPluginPage(id);
    else closeSettingsPluginPage();
  };
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // The worker's log tail, open for one plugin; refreshed every two seconds while open.
  const [logsOf, setLogsOf] = useState<string | null>(null);
  const [logText, setLogText] = useState('');
  useEffect(() => {
    if (!logsOf) return;
    let on = true;
    const pull = () => api.pluginLogs(logsOf, 200).then((t) => { if (on) setLogText(t); }).catch(() => { if (on) setLogText('(no log yet)'); });
    pull();
    const timer = setInterval(pull, 2000);
    return () => { on = false; clearInterval(timer); };
  }, [logsOf]);
  const [err, setErr] = useState('');
  const [removing, setRemoving] = useState<PluginRow | null>(null);
  // Off by default: kept data can be deleted later, deleted data cannot come back (2026-11-07).
  const [deleteData, setDeleteData] = useState(false);
  const [copying, setCopying] = useState<{ id: string; newId: string } | null>(null);
  // Export and import of a plugin's data (2026-11-07): the chosen file, and the result or error shown on its page.
  const [importing, setImporting] = useState<{ row: PluginRow; file: File; docs: number; settings: boolean } | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [dataMsg, setDataMsg] = useState<{ id: string; text: string; error: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [safe, setSafe] = useState(isSafeMode());
  const [safeTouched, setSafeTouched] = useState(false);
  // Marketplaces and the catalog (spec section 7): loaded with the page; the catalog after any change.
  const [markets, setMarkets] = useState<Marketplace[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [marketUrl, setMarketUrl] = useState('');
  const [marketErr, setMarketErr] = useState('');
  const [marketBusy, setMarketBusy] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState<string | null>(null);
  const [pinning, setPinning] = useState<{ id: string; versions: MarketVersion[] } | null>(null);
  const loadMarkets = async () => {
    try { setMarkets((await api.listMarketplaces()).marketplaces); } catch { setMarkets([]); }
    try { setCatalog((await api.pluginCatalog()).entries); } catch { setCatalog([]); }
  };
  useEffect(() => { void loadMarkets(); }, []);
  const marketRun = async (key: string, fn: () => Promise<unknown>) => {
    setMarketBusy(key); setMarketErr('');
    try { await fn(); await loadMarkets(); await refresh(); } catch (e) { setMarketErr(e instanceof Error ? e.message : String(e)); }
    setMarketBusy(null);
  };
  const marketName = (url: string) => markets.find((m) => m.url === url)?.name ?? markets.find((m) => m.url === url)?.slug ?? null;

  const refresh = async () => {
    try { const r = await api.listPlugins(); usePluginRegistry.getState().setManifests(r.plugins); } catch { /* the list stays as it was */ }
    setLoaded(true);
  };
  useEffect(() => { void refresh(); }, []);

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setErr('');
    try { await fn(); await refresh(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };
  const toggle = (r: PluginRow) => run(r.id, async () => {
    const next = r.enabled ? await api.disablePlugin(r.id) : await api.enablePlugin(r.id);
    await reloadPlugin(next);
  });
  const reload = (r: PluginRow) => run(r.id, async () => { const next = await api.reloadPlugin(r.id); await reloadPlugin(next); });
  const create = () => {
    const id = newId.trim(); const name = newName.trim();
    if (!ID_RE.test(id)) { setErr('The id is lowercase letters, digits and dashes, up to 64, and starts with a letter or digit.'); return; }
    if (!name) { setErr('Give the plugin a name.'); return; }
    void run(id, async () => { await api.scaffoldPlugin(id, name); setCreating(false); setNewId(''); setNewName(''); });
  };
  const remove = (r: PluginRow) => { setRemoving(null); setOpenId(null); void run(r.id, async () => { await api.removePlugin(r.id, { keepData: !deleteData }); usePluginRegistry.getState().unregister(r.id); }); };
  const promote = (key: string, on: boolean) => {
    const next = on ? [...promoted.filter((k) => k !== key), key] : promoted.filter((k) => k !== key);
    usePluginRegistry.getState().setPromoted(next);
  };
  const exportData = async (r: PluginRow) => {
    try { await api.exportPluginData(r.id); } catch (e) { setDataMsg({ id: r.id, text: e instanceof Error ? e.message : String(e), error: true }); }
  };
  const pickImport = async (r: PluginRow, file: File | undefined) => {
    if (!file) return;
    setDataMsg(null);
    let parsed: { docs?: unknown; settings?: unknown };
    try { parsed = JSON.parse(await readFileText(file)) as typeof parsed; } catch { setDataMsg({ id: r.id, text: 'This is not a valid export file.', error: true }); return; }
    setImportMode('merge');
    setImporting({ row: r, file, docs: Array.isArray(parsed?.docs) ? parsed.docs.length : 0, settings: parsed?.settings !== null && parsed?.settings !== undefined });
  };
  const runImport = async () => {
    if (!importing) return;
    const { row: r, file } = importing;
    setImporting(null);
    setBusy(r.id);
    try {
      const out = await api.importPluginData(r.id, file, importMode);
      const parts = [`${out.docs} document${out.docs === 1 ? '' : 's'}`, ...(out.files ? [`${out.files} file${out.files === 1 ? '' : 's'}`] : []), ...(out.settings ? ['the settings'] : [])];
      const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
      // The daemon announces each changed document and the settings, so an open plugin sees them.
      setDataMsg({ id: r.id, text: `Imported ${list}.`, error: false });
    } catch (e) { setDataMsg({ id: r.id, text: e instanceof Error ? e.message : String(e), error: true }); }
    setBusy(null);
  };
  const toggleSafe = () => { const next = !safe; setSafeMode(next); setSafe(next); setSafeTouched(true); };
  const copy = (r: PluginRow) => { const newId = (copying?.newId ?? '').trim(); if (!ID_RE.test(newId)) { setErr('The new id is lowercase letters, digits and dashes.'); return; } void run(r.id, async () => { await api.copyPlugin(r.id, newId); setCopying(null); }); };
  const open = (id: string) => { setOpenId(id); setErr(''); setCopying(null); setPinning(null); setNotesOpen(null); };
  const close = () => { setOpenId(null); setErr(''); setCopying(null); setPinning(null); };

  const local = manifests.filter((m) => !m.install && !m.bundled);
  const installed = manifests.filter((m) => m.install);
  const bundled = manifests.filter((m) => m.bundled);
  const viewsOf = (id: string): PluginView[] => views.filter((v) => v.plugin === id);
  const iconOf = (r: PluginRow) => pluginIcon(r.contributes?.views?.[0]?.icon ?? viewsOf(r.id)[0]?.icon);
  const sourceOf = (r: PluginRow): string => (r.bundled ? 'Bundled' : r.install ? (r.marketplaceGone ? 'Marketplace removed' : marketName(r.install.marketplace) ?? 'Marketplace') : 'Local');

  /** The on/off switch, the same on the row and on the page. Clicks do not reach the row under it. */
  const enableSwitch = (r: PluginRow) => (
    <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>
      <Toggle on={r.enabled} label={`Enable ${r.name}`} disabled={busy === r.id || !!r.error} onClick={() => void toggle(r)} />
    </span>
  );

  const renderRow = (r: PluginRow, i: number) => {
    const att = attentionOf(r, status[r.id]);
    const Icon = iconOf(r);
    return (
      <div key={r.id} data-testid={`plugin-row-${r.id}`} onClick={() => open(r.id)} style={{ ...groupRow(i), cursor: 'pointer' }}>
        <button type="button" aria-label={`Open ${r.name}`} onClick={(e) => { e.stopPropagation(); open(r.id); }}
          style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, padding: 0, background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' }}>
          <IconTile icon={Icon} size={32} dim={!r.enabled} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ ...title, display: 'block', color: r.enabled ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>{r.name}</span>
            {att ? (
              <span data-testid={`plugin-attention-${r.id}`} style={{ ...oneLine, display: 'flex', alignItems: 'center', gap: 6, color: TONE_VAR[att.tone] }}><Dot tone={att.tone} />{att.label}</span>
            ) : r.description ? <span style={oneLine}>{r.description}</span> : null}
          </span>
        </button>
        {enableSwitch(r)}
        <CaretRight aria-hidden size={16} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
      </div>
    );
  };

  const renderDetail = (r: PluginRow) => {
    const s = status[r.id];
    const Icon = iconOf(r);
    const mine = viewsOf(r.id);
    const loadErr = loadError(r, s);
    const showStatus = !!loadErr || !!r.worker || (r.assist?.calls ?? 0) > 0 || !!r.hooks;
    const disabled = busy === r.id;
    const path = `~/.dispatch/plugins/${r.id}`;
    const contributes = r.contributes ? Object.entries(r.contributes).filter(([, v]) => Array.isArray(v) ? v.length > 0 : !!v).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x as { id: string }).id)).join(', ') : Object.keys(v as object).join(', ')}`) : [];
    const devRow = (label: string, value: React.ReactNode, i: number, extra?: React.ReactNode) => (
      <div key={label} style={{ ...groupRow(i), alignItems: 'flex-start' }}>
        <span style={{ ...note, width: 92, flexShrink: 0 }}>{label}</span>
        <span style={{ ...mono, flex: 1, color: 'var(--color-text-secondary)' }}>{value}</span>
        {extra}
      </div>
    );
    const dev: [string, React.ReactNode, React.ReactNode?][] = [
      ['Folder', path, <button key="cp" type="button" style={{ ...ghostBtn, height: 26, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 5 }} onClick={() => void copyText(path).then(() => useHint.getState().show('Path copied')).catch(() => {})}><CopyIcon size={13} />Copy path</button>],
      ['Id', r.id],
      ['Version', r.version],
      ['Key', r.keyed ? `Key issued · ~/.dispatch/keys/plugin-${r.id}` : 'No key'],
      ...(r.worker ? [['Worker', `${[r.worker.command, ...r.worker.args].join(' ')}${r.workerStats?.pid ? ` · pid ${r.workerStats.pid}` : ''}`] as [string, React.ReactNode]] : []),
      ...(r.worker?.jobs.length ? [['Jobs', r.worker.jobs.map((j) => `${j.id} (${j.cron})`).join(', ')] as [string, React.ReactNode]] : []),
      ...(r.web ? [['Web bundle', r.web] as [string, React.ReactNode]] : []),
      ...(r.sdk !== undefined ? [['SDK', String(r.sdk)] as [string, React.ReactNode]] : []),
      ...(r.dispatch ? [['Dispatch', r.dispatch] as [string, React.ReactNode]] : []),
      ...(r.author ? [['Author', r.author] as [string, React.ReactNode]] : []),
      ...(contributes.length ? [['Contributes', contributes.join(' · ')] as [string, React.ReactNode]] : []),
      ...(r.hooks ? [['Hooks', `${r.hooks.runs} runs · ${r.hooks.failures} failed · ${r.hooks.dropped} dropped`] as [string, React.ReactNode]] : []),
      ...(r.install ? [['Installed from', r.install.marketplace] as [string, React.ReactNode]] : []),
      ...(r.shadowsBundled ? [['Note', 'This local folder hides a bundled plugin with the same id.'] as [string, React.ReactNode]] : []),
    ];
    return (
      <SettingsSubPage testId={`plugin-detail-${r.id}`} headerTestId="plugin-detail-header" icon={Icon} title={r.name} subtitle={`v${r.version} · ${sourceOf(r)}`} description={r.description}
        backLabel="Plugins" onBack={isMobile ? undefined : close}>

        <div style={group}>
          <div style={groupRow(0)}>
            <span style={{ ...body, flex: 1 }}>Enabled</span>
            {enableSwitch(r)}
          </div>
          {mine.map((v, i) => {
            const on = promoted.includes(v.key);
            const full = !on && promoted.length >= PROMOTED_MAX;
            const label = mine.length === 1 && v.label === r.name ? 'Show as a phone tab' : `Show ${v.label} as a phone tab`;
            return (
              <div key={v.key} style={{ ...groupRow(i + 1), flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ ...body, display: 'block' }}>{label}</span>
                  {full && <span style={{ ...note, display: 'block' }}>The phone has room for two tabs. Turn one off first.</span>}
                </span>
                <Toggle on={on} disabled={full} label={`Show ${v.label} as a phone tab`} onClick={() => promote(v.key, !on)} />
              </div>
            );
          })}
        </div>

        {r.install && (
          <section aria-label="Updates" style={stack}>
            <GroupLabel>UPDATES</GroupLabel>
            <div style={group}>
              <div style={{ ...groupRow(0), flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ ...body, display: 'block' }}>{r.update ? `v${r.update.to} available` : 'Up to date'}</span>
                  <span style={{ ...note, display: 'block' }} title={r.install.marketplace}>
                    {r.marketplaceGone ? 'Marketplace removed' : `From ${marketName(r.install.marketplace) ?? 'a marketplace'}`}{r.pinned ? ` · Pinned to v${r.pinned}` : ''}
                  </span>
                </span>
                {r.update?.changelog && <button type="button" style={ghostBtn} onClick={() => setNotesOpen(notesOpen === r.id ? null : r.id)}>What's new</button>}
                <button type="button" style={solidBtn(!(disabled || !r.update || r.marketplaceGone))} disabled={disabled || !r.update || r.marketplaceGone} onClick={() => run(r.id, () => api.updatePlugin(r.id))}>Update</button>
              </div>
              {notesOpen === r.id && r.update?.changelog && (
                <div style={{ ...groupRow(1), display: 'block' }}>
                  <pre style={{ margin: 0, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '12px/1.5 var(--font-mono)', color: 'var(--color-text-secondary)' }}>{r.update.changelog}</pre>
                </div>
              )}
              <div style={groupRow(1)}>
                <span style={{ ...body, flex: 1 }}>Auto-update</span>
                <Toggle on={r.autoUpdate === true} label="Auto-update" onClick={() => run(r.id, () => api.setPluginAutoUpdate(r.id, !r.autoUpdate))} />
              </div>
              <div style={{ ...groupRow(1), flexWrap: 'wrap' }}>
                {pinning?.id === r.id ? (
                  <>
                    <Select ariaLabel="Pin to version" value={r.pinned ?? ''} onChange={(picked) => { const v = picked || null; setPinning(null); void run(r.id, () => api.pinPlugin(r.id, v)); }} style={{ width: 160 }}
                      options={[{ value: '', label: 'No pin' }, ...pinning.versions.map((v) => ({ value: v.version, label: `v${v.version}` }))]} />
                    <button type="button" style={ghostBtn} onClick={() => setPinning(null)}>Cancel</button>
                    <span style={note}>A pin stops updates past that version.</span>
                  </>
                ) : (
                  <div style={buttons}>
                    <button type="button" style={ghostBtn} disabled={disabled} onClick={() => run(r.id, () => api.rollbackPlugin(r.id))}>Roll back</button>
                    <button type="button" style={ghostBtn} disabled={disabled} onClick={() => void api.pluginVersions(r.id).then((v) => setPinning({ id: r.id, versions: v.versions })).catch(() => setPinning({ id: r.id, versions: [] }))}>Pin…</button>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        <section aria-label="Permissions section" style={stack}>
          <GroupLabel>PERMISSIONS</GroupLabel>
          {r.permissions && r.permissions.length > 0 ? (
            <ul role="list" aria-label="Permissions" style={{ ...group, margin: 0, padding: 0, listStyle: 'none' }}>
              {r.permissions.map((perm, i) => {
                const words = PERMISSION_WORDS[perm];
                return (
                  <li key={perm} style={{ ...groupRow(i), justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 2 }}>
                    <span style={body}>{words ?? perm}</span>
                    {words && <span style={mono}>{perm}</span>}
                  </li>
                );
              })}
            </ul>
          ) : <div style={{ ...group, ...groupRow(0), ...note, borderTop: '1px solid var(--color-border)' }}>No permissions</div>}
        </section>

        {showStatus && (
          <section aria-label="Status" style={stack}>
            <GroupLabel>STATUS</GroupLabel>
            <div style={group}>
              {loadErr && (
                <div role="note" style={{ ...groupRow(0), alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>
                  <Dot tone="red" /><span style={{ marginTop: -4 }}>{loadErr}</span>
                </div>
              )}
              {r.worker && (
                <div style={{ ...groupRow(loadErr ? 1 : 0), flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Dot tone={workerTone(r.workerStats)} />
                    <span style={body}>{workerLabel(r.workerStats)}</span>
                  </span>
                  <div style={buttons}>
                    <button type="button" style={ghostBtn} onClick={() => { setLogText(''); setLogsOf(r.id); }}>Logs</button>
                    <button type="button" style={ghostBtn} disabled={disabled || !r.enabled} onClick={() => { setBusy(r.id); void api.restartPluginWorker(r.id).then(() => refresh()).catch(() => {}).finally(() => setBusy(null)); }}>Restart</button>
                  </div>
                </div>
              )}
              {r.assist && r.assist.calls > 0 && (
                <div style={groupRow(loadErr || r.worker ? 1 : 0)}>
                  <span data-testid={`plugin-assist-${r.id}`} style={{ ...note, fontSize: 12 }}>{assistLine(r.assist)}</span>
                </div>
              )}
              {r.hooks && (
                <div style={groupRow(loadErr || r.worker || (r.assist?.calls ?? 0) > 0 ? 1 : 0)}>
                  <span style={{ ...note, fontSize: 12 }}>Hooks: {r.hooks.runs} runs{r.hooks.failures ? `, ${r.hooks.failures} failed` : ''}{r.hooks.dropped ? `, ${r.hooks.dropped} dropped` : ''}</span>
                </div>
              )}
            </div>
          </section>
        )}

        <section aria-label="Actions" style={stack}>
          <GroupLabel>ACTIONS</GroupLabel>
          <div style={{ ...group, padding: '12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={buttons}>
              <button type="button" style={ghostBtn} disabled={disabled || !r.enabled} onClick={() => void reload(r)}>Reload</button>
              <button type="button" style={ghostBtn} disabled={disabled} onClick={() => void exportData(r)}>Export data</button>
              <button type="button" style={ghostBtn} disabled={disabled} onClick={() => fileInput.current?.click()}>Import data…</button>
              {r.bundled && <button type="button" style={ghostBtn} onClick={() => setCopying({ id: r.id, newId: `my-${r.id}` })}>Copy to local…</button>}
              {!r.bundled && <button type="button" style={{ ...ghostBtn, color: 'var(--color-status-red)' }} disabled={disabled} onClick={() => (setDeleteData(false), setRemoving(r))}>Remove</button>}
              <input ref={fileInput} type="file" accept="application/json,.json" aria-label={`Import file for ${r.id}`} style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void pickImport(r, f); }} />
            </div>
            {copying?.id === r.id && (
              <div style={buttons}>
                <input aria-label="New plugin id" value={copying.newId} onChange={(e) => setCopying({ id: r.id, newId: e.target.value })} style={{ ...fieldInput, width: 180 }} />
                <button type="button" style={solidBtn(true)} disabled={disabled} onClick={() => copy(r)}>Copy</button>
                <button type="button" style={ghostBtn} onClick={() => setCopying(null)}>Cancel</button>
                <span style={note}>A local copy you can change. The bundled one stays as it is.</span>
              </div>
            )}
            {dataMsg?.id === r.id && (
              <div role={dataMsg.error ? 'alert' : 'status'} style={{ fontSize: 12.5, lineHeight: 1.5, overflowWrap: 'anywhere', color: dataMsg.error ? 'var(--color-status-red)' : 'var(--color-text-secondary)' }}>{dataMsg.text}</div>
            )}
            {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{err}</div>}
          </div>
        </section>

        <details data-testid="plugin-developer" style={{ ...group }}>
          <summary style={{ padding: '11px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)' }}>Developer</summary>
          {dev.map(([label, value, extra], i) => devRow(label, value, i + 1, extra))}
        </details>
      </SettingsSubPage>
    );
  };

  const opened = openId ? manifests.find((m) => m.id === openId) : undefined;

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>Plugins add screens and tools to Dispatch. Bundled ones update with the app.</div>

      {bundled.length > 0 && (
        <section aria-label="Bundled plugins" style={stack}>
          <GroupLabel>BUNDLED</GroupLabel>
          <div style={group}>{bundled.map(renderRow)}</div>
        </section>
      )}

      {installed.length > 0 && (
        <section aria-label="Installed plugins" style={stack}>
          <GroupLabel>INSTALLED</GroupLabel>
          <div style={group}>{installed.map(renderRow)}</div>
        </section>
      )}

      <section aria-label="Local plugins" style={stack}>
        <GroupLabel action={<button type="button" style={ghostBtn} onClick={() => { setCreating((c) => !c); setErr(''); }}>New plugin…</button>}>LOCAL</GroupLabel>
        {creating && (
          <div style={{ ...group, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              Plugin id
              <input aria-label="Plugin id" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="daily-rundown" style={fieldInput} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
              Plugin name
              <input aria-label="Plugin name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Daily rundown" style={fieldInput} />
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={solidBtn(true)} disabled={busy !== null} onClick={create}>Create</button>
              <button type="button" style={ghostBtn} onClick={() => { setCreating(false); setErr(''); }}>Cancel</button>
            </div>
          </div>
        )}
        {err && !opened && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{err}</div>}
        {local.length > 0 && <div style={group}>{local.map(renderRow)}</div>}
        {loaded && local.length === 0 && !creating && (
          <div style={{ ...note, fontSize: 12.5, padding: '0 4px' }}>
            {manifests.length === 0 ? 'No plugins yet. ' : 'No local plugins. '}New plugin… writes a starter folder under ~/.dispatch/plugins that you or a thread can edit. It reloads as you save.
          </div>
        )}
      </section>

      <section aria-label="Marketplaces" style={stack}>
        <GroupLabel>MARKETPLACES</GroupLabel>
        {markets.length > 0 && (
          <div style={group}>
            {markets.map((m, i) => (
              <div key={m.slug} data-testid={`marketplace-${m.slug}`} style={{ ...groupRow(i), flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ ...title, display: 'block' }}>{m.name ?? m.slug}</span>
                    <span style={{ ...oneLine, fontFamily: 'var(--font-mono)', fontSize: 11 }} title={m.url}>{m.url}</span>
                  </span>
                  <span style={{ ...note, fontSize: 12 }} title="Plugins from a trusted marketplace update on their own">Trusted</span>
                  <Toggle on={m.trusted} label="Trusted" onClick={() => void marketRun(m.slug, () => api.setMarketplaceTrusted(m.slug, !m.trusted))} />
                </div>
                {m.description && <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{m.description}</div>}
                {m.error && <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{m.error}{/username|publickey|permission denied|authentication failed|could not read from remote|terminal prompts disabled/i.test(m.error) ? ' — sign in with gh auth login or add an ssh key.' : ''}</div>}
                <div style={buttons}>
                  <button type="button" style={ghostBtn} disabled={marketBusy !== null} onClick={() => void marketRun(m.slug, () => api.pullMarketplace(m.slug))}>Check now</button>
                  <button type="button" style={{ ...ghostBtn, color: 'var(--color-status-red)' }} disabled={marketBusy !== null} onClick={() => void marketRun(m.slug, () => api.removeMarketplace(m.slug))}>Remove</button>
                  {m.lastPulledAt && <span style={{ ...note, marginLeft: 'auto' }}>Checked {new Date(m.lastPulledAt).toLocaleString()}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input aria-label="Marketplace URL" value={marketUrl} onChange={(e) => setMarketUrl(e.target.value)} placeholder="https://github.com/your-org/plugins.git" style={{ ...fieldInput, flex: 1, minWidth: 200 }} />
          <button type="button" style={solidBtn(marketUrl.trim().length > 0)} disabled={marketBusy !== null || !marketUrl.trim()} onClick={() => void marketRun('add', async () => { await api.addMarketplace(marketUrl.trim()); setMarketUrl(''); })}>Add marketplace</button>
        </div>
        {marketErr && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{marketErr}</div>}
        <div style={{ ...note, padding: '0 4px' }}>A marketplace is a git repository. Add it by URL (https, ssh, or a path). The daemon clones it with your own git login, so a private repository is a private marketplace.</div>
      </section>

      {catalog.length > 0 && (
        <section aria-label="Browse" style={stack}>
          <GroupLabel>BROWSE</GroupLabel>
          {markets.map((m) => {
            const mine = catalog.filter((e) => e.marketplace === m.slug);
            if (mine.length === 0) return null;
            const entries = (['plugin', 'skill'] as const).flatMap((kind) => mine.filter((e) => e.kind === kind));
            return (
              <div key={m.slug} style={stack}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', padding: '0 4px' }}>{m.name ?? m.slug}</div>
                <div style={group}>
                  {entries.map((e, i) => (
                    <div key={`${e.kind}:${e.id}`} data-testid={`catalog-${e.kind}-${e.id}`} style={groupRow(i)}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ ...title, display: 'block' }}>{e.name}</span>
                        <span style={oneLine}>{e.kind === 'skill' ? 'Skill' : 'Plugin'} · v{e.version}{e.description ? ` · ${e.description}` : ''}</span>
                      </span>
                      {e.installed
                        ? <span style={{ ...note, fontSize: 12, flexShrink: 0 }}>Installed v{e.installed.version}</span>
                        : <button type="button" style={solidBtn(marketBusy === null)} disabled={marketBusy !== null} onClick={() => void marketRun(`${e.kind}:${e.id}`, () => (e.kind === 'plugin' ? api.installPlugin(m.slug, e.id) : api.installSkill(m.slug, e.id)))}>Install</button>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section aria-label="Safe mode" style={stack}>
        <GroupLabel>SAFE MODE</GroupLabel>
        <div style={group}>
          <div style={groupRow(0)}>
            <span style={{ ...body, flex: 1 }}>Load no plugins</span>
            <Toggle on={safe} onClick={toggleSafe} label="Safe mode" />
          </div>
        </div>
        <div style={{ ...note, padding: '0 4px' }}>{safeTouched ? 'Reload the app to apply. ' : ''}Adding ?safe to the app's address does the same for one visit.</div>
      </section>
    </div>
  );

  return (
    <>
      {/* The page takes the section's place. On a phone the app header carries its back arrow and
          name, and the tab bar stays below it. */}
      {opened ? renderDetail(opened) : list}

      <Modal open={logsOf !== null} onClose={() => setLogsOf(null)} title={logsOf ? `Worker log · ${logsOf}` : 'Worker log'} maxWidth={760}>
        <pre style={{ margin: 0, maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '12px/1.5 var(--font-mono)', color: 'var(--color-text-primary)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>{logText || 'Loading…'}</pre>
        <div style={{ ...note, marginTop: 8 }}>The last 200 lines of plugins/{logsOf}.log in the daemon's log folder, refreshed every two seconds.</div>
      </Modal>
      <ConfirmModal open={removing !== null} title="Remove this plugin?" danger confirmLabel="Remove plugin"
        message={removing ? `The folder ~/.dispatch/plugins/${removing.id} will be deleted. Its saved data and settings are kept, and come back if you install it again.` : ''}
        onConfirm={() => removing && remove(removing)} onCancel={() => setRemoving(null)}>
        <div style={{ marginTop: 12 }}>
          <button type="button" style={ghostBtn} onClick={() => removing && void api.exportPluginData(removing.id).catch((e) => setErr(e instanceof Error ? e.message : String(e)))}>Download data and settings</button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: 'var(--color-text-primary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
          Also delete its data and settings
        </label>
      </ConfirmModal>
      <ConfirmModal open={importing !== null} title="Import data?" confirmLabel="Import"
        message={importing ? `Import ${importing.docs} document${importing.docs === 1 ? '' : 's'}${importing.settings ? ' and settings' : ''} into ${importing.row.name}?` : ''}
        onConfirm={() => void runImport()} onCancel={() => setImporting(null)}>
        <div role="radiogroup" aria-label="Import mode" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          <label style={radioLabel}>
            <input type="radio" name="import-mode" checked={importMode === 'merge'} onChange={() => setImportMode('merge')} />
            <span>Merge: <span style={{ color: 'var(--color-text-secondary)' }}>overwrite the same keys, keep the others</span></span>
          </label>
          <label style={radioLabel}>
            <input type="radio" name="import-mode" checked={importMode === 'replace'} onChange={() => setImportMode('replace')} />
            <span>Replace: <span style={{ color: 'var(--color-text-secondary)' }}>delete the current data and settings first</span></span>
          </label>
        </div>
      </ConfirmModal>
    </>
  );
}
