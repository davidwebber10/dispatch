import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { PluginRow } from '../../api/types';
import { usePluginRegistry, PROMOTED_MAX, type PluginStatus } from '../../plugins/registry';
import { isSafeMode, setSafeMode, reloadPlugin } from '../../plugins/host';
import { ConfirmModal } from '../common/ConfirmModal';
import { Modal } from '../common/Modal';
import { copyText } from '../../lib/clipboard';
import { useHint } from '../../stores/hint';
import { sectionLabel, row, item, ghostBtn, solidBtn, fieldInput, miniChip, Toggle } from './ui';

const note: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-text-tertiary)' };
const card: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)' };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One line per permission, for the chip's title (docs/plugins.md lists the same). */
const PERMISSION_MEANING: Record<string, string> = {
  'read:projects': 'Reads the project list',
  'read:threads': 'Reads threads and transcripts',
  'read:ledger': 'Reads project ledgers',
  'write:ledger': 'Adds to project ledgers',
  'read:prompts': 'Sees the text of your prompts in hooks',
  'message:threads': 'Sends messages to threads',
  'spawn:threads': 'Starts threads',
  'notify': 'Sends push notifications and hints',
  'storage': 'Keeps its own documents and settings',
  'threads:read-storage': 'Lets threads read its documents',
  'threads:write-storage': 'Lets threads write its documents',
  'threads:call-worker': 'Lets threads call its worker',
  'model:assist': 'Makes model calls of its own',
  'network': 'Its worker makes calls out to the internet',
};

/** One word for the row's state chip, from the daemon's row and the host's load status. */
function stateOf(r: PluginRow, s: PluginStatus | undefined): { label: string; tone: 'accent' | 'red' | 'muted'; detail?: string } {
  if (r.error) return { label: 'Broken', tone: 'red', detail: r.error };
  if (!r.enabled) return { label: 'Disabled', tone: 'muted' };
  if (!s) return { label: r.web ? 'Not loaded' : 'Ready', tone: 'muted' };
  if (s.state === 'error') return { label: 'Error', tone: 'red', detail: s.error };
  if (s.state === 'loading') return { label: 'Loading', tone: 'muted' };
  return { label: 'Ready', tone: 'accent' };
}

/**
 * Settings → Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.5): local
 * plugins first, then the installed ones, then safe mode. Browse and install come with the
 * marketplace slice.
 */
/** "Worker running · pid 4242 · 2 restarts", "Worker crashed · exit 1 · 10 restarts", "Worker backing off", "Worker stopped". */
function workerLabel(w: PluginRow['workerStats']): string {
  if (!w) return 'Worker stopped';
  const restarts = w.restarts > 0 ? ` · ${w.restarts} restart${w.restarts === 1 ? '' : 's'}` : '';
  if (w.state === 'running') return `Worker running${w.pid ? ` · pid ${w.pid}` : ''}${restarts}`;
  if (w.state === 'crashed') return `Worker crashed${w.lastExit ? ` · ${w.lastExit.signal ? `signal ${w.lastExit.signal}` : `exit ${w.lastExit.code ?? '?'}`}` : ''}${restarts}`;
  if (w.state === 'backoff') return `Worker backing off${restarts}`;
  return 'Worker stopped';
}
const workerTone = (w: PluginRow['workerStats']): string => (w?.state === 'running' ? 'var(--color-accent)' : w?.state === 'crashed' ? 'var(--color-status-red)' : w?.state === 'backoff' ? 'var(--color-status-yellow)' : 'var(--color-text-tertiary)');

export function PluginsSection() {
  const manifests = usePluginRegistry((s) => s.manifests);
  const status = usePluginRegistry((s) => s.status);
  const views = usePluginRegistry((s) => s.views);
  const promoted = usePluginRegistry((s) => s.promoted);
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
  const [copying, setCopying] = useState<{ id: string; newId: string } | null>(null);
  const [safe, setSafe] = useState(isSafeMode());
  const [safeTouched, setSafeTouched] = useState(false);

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
  const remove = (r: PluginRow) => { setRemoving(null); void run(r.id, async () => { await api.removePlugin(r.id); usePluginRegistry.getState().unregister(r.id); }); };
  const promote = (key: string, on: boolean) => {
    const next = on ? [...promoted.filter((k) => k !== key), key] : promoted.filter((k) => k !== key);
    usePluginRegistry.getState().setPromoted(next);
  };
  const toggleSafe = () => { const next = !safe; setSafeMode(next); setSafe(next); setSafeTouched(true); };

  const local = manifests.filter((m) => !m.install && !m.bundled);
  const installed = manifests.filter((m) => m.install);
  const bundled = manifests.filter((m) => m.bundled);
  const copy = (r: PluginRow) => { const newId = (copying?.newId ?? '').trim(); if (!ID_RE.test(newId)) { setErr('The new id is lowercase letters, digits and dashes.'); return; } void run(r.id, async () => { await api.copyPlugin(r.id, newId); setCopying(null); }); };

  const renderRow = (r: PluginRow) => {
    const st = stateOf(r, status[r.id]);
    const mine = views.filter((v) => v.plugin === r.id);
    const chipColor = st.tone === 'accent' ? 'var(--color-accent)' : st.tone === 'red' ? 'var(--color-status-red)' : 'var(--color-text-tertiary)';
    return (
      <div key={r.id} data-testid={`plugin-row-${r.id}`} style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{r.name}</span>
          <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>v{r.version}</span>
          <span style={{ ...miniChip, color: chipColor, borderColor: chipColor }}>{st.label}</span>
          {r.install && <span style={miniChip}>{r.install.marketplace}</span>}
          {r.bundled && <span style={miniChip} title="Ships with Dispatch and updates with it">Bundled</span>}
          {r.shadowsBundled && <span style={miniChip} title="A bundled plugin with this id is hidden by this local one">Shadows bundled</span>}
        </div>
        {r.description && <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{r.description}</div>}
        {st.detail && <div role="note" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{st.detail}</div>}
        <div style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>~/.dispatch/plugins/{r.id}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {r.permissions && r.permissions.length > 0 ? (
            <ul role="list" aria-label="Permissions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: 0, padding: 0, listStyle: 'none' }}>
              {r.permissions.map((perm) => (
                <li key={perm} title={PERMISSION_MEANING[perm] ?? 'A permission this Dispatch does not know'} style={{ ...miniChip, textTransform: 'none', letterSpacing: 0, color: PERMISSION_MEANING[perm] ? 'var(--color-text-secondary)' : 'var(--color-status-yellow)' }}>{perm}</li>
              ))}
            </ul>
          ) : <span style={note}>No permissions</span>}
          {r.keyed && <span style={{ ...miniChip, color: 'var(--color-accent)', borderColor: 'var(--color-accent)' }} title="The plugin's processes can use ~/.dispatch/keys/plugin-{r.id}">Key issued</span>}
        </div>
        {r.worker && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ ...miniChip, textTransform: 'none', letterSpacing: 0, color: workerTone(r.workerStats), borderColor: workerTone(r.workerStats) }}>{workerLabel(r.workerStats)}</span>
            <button type="button" style={ghostBtn} onClick={() => { setLogText(''); setLogsOf(r.id); }}>Logs</button>
            <button type="button" style={ghostBtn} disabled={busy === r.id || !r.enabled} onClick={() => { setBusy(r.id); void api.restartPluginWorker(r.id).then(() => refresh()).catch(() => {}).finally(() => setBusy(null)); }}>Restart</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" style={ghostBtn} disabled={busy === r.id || !!r.error} onClick={() => void toggle(r)}>{r.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" style={ghostBtn} disabled={busy === r.id || !r.enabled} onClick={() => void reload(r)}>Reload</button>
          <button type="button" style={ghostBtn} onClick={() => void copyText(`~/.dispatch/plugins/${r.id}`).then(() => useHint.getState().show('Path copied')).catch(() => {})}>Copy path</button>
          {!r.install && !r.bundled && <button type="button" style={{ ...ghostBtn, color: 'var(--color-status-red)' }} disabled={busy === r.id} onClick={() => setRemoving(r)}>Remove</button>}
          {r.bundled && <button type="button" style={ghostBtn} onClick={() => setCopying({ id: r.id, newId: `my-${r.id}` })}>Copy to local…</button>}
        </div>
        {copying?.id === r.id && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input aria-label="New plugin id" value={copying.newId} onChange={(e) => setCopying({ id: r.id, newId: e.target.value })} style={{ ...fieldInput, width: 180 }} />
            <button type="button" style={solidBtn(true)} disabled={busy === r.id} onClick={() => copy(r)}>Copy</button>
            <button type="button" style={ghostBtn} onClick={() => setCopying(null)}>Cancel</button>
            <span style={note}>A local copy you can change; the bundled one stays as it is.</span>
          </div>
        )}
        {mine.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={note}>Phone tabs:</span>
            {mine.map((v) => {
              const on = promoted.includes(v.key);
              const full = !on && promoted.length >= PROMOTED_MAX;
              return (
                <button key={v.key} type="button" style={{ ...ghostBtn, opacity: full ? 0.5 : 1 }} disabled={full}
                  aria-label={on ? `Remove the tab for ${v.label}` : `Promote ${v.label} to a tab`} onClick={() => promote(v.key, !on)}>
                  {on ? `${v.label}: tab on` : `${v.label}: give it a tab`}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section aria-label="Local plugins" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={row}>
          <span style={sectionLabel}>LOCAL</span>
          <button type="button" style={ghostBtn} onClick={() => { setCreating((c) => !c); setErr(''); }}>New plugin…</button>
        </div>
        <div style={note}>A folder under ~/.dispatch/plugins is a plugin. Edit its files and the app reloads it as you save. A thread can write one too.</div>
        {creating && (
          <div style={{ ...card, gap: 10 }}>
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
        {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{err}</div>}
        {loaded && local.length === 0 && !creating && (
          <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-tertiary)' }}>No plugins yet. New plugin… writes a starter folder you or a thread can edit; it shows up here as it is saved.</div>
        )}
        {local.map(renderRow)}
      </section>

      {bundled.length > 0 && (
        <section aria-label="Bundled plugins" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={sectionLabel}>BUNDLED</span>
          <div style={note}>Ship with Dispatch and update with it. Disable one here; copy it to local to change it.</div>
          {bundled.map(renderRow)}
        </section>
      )}

      {installed.length > 0 && (
        <section aria-label="Installed plugins" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={sectionLabel}>INSTALLED</span>
          {installed.map(renderRow)}
        </section>
      )}

      <section aria-label="Safe mode" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={sectionLabel}>SAFE MODE</span>
        <div style={row}>
          <span style={item}>Load no plugins</span>
          <Toggle on={safe} onClick={toggleSafe} label="Safe mode" />
        </div>
        <div style={note}>{safeTouched ? 'Reload the app to apply. ' : ''}Adding ?safe to the app's address does the same for one visit.</div>
      </section>

      <Modal open={logsOf !== null} onClose={() => setLogsOf(null)} title={logsOf ? `Worker log · ${logsOf}` : 'Worker log'} maxWidth={760}>
        <pre style={{ margin: 0, maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '12px/1.5 var(--font-mono)', color: 'var(--color-text-primary)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>{logText || 'Loading…'}</pre>
        <div style={{ ...note, marginTop: 8 }}>The last 200 lines of ~/Library/Logs/dispatch/plugins/{logsOf}.log, refreshed every two seconds.</div>
      </Modal>
      <ConfirmModal open={removing !== null} title="Remove this plugin?" danger confirmLabel="Remove plugin"
        message={removing ? `The folder ~/.dispatch/plugins/${removing.id} and everything in it will be deleted.` : ''}
        onConfirm={() => removing && remove(removing)} onCancel={() => setRemoving(null)} />
    </div>
  );
}
