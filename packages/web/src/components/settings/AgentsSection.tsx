import { useEffect, useRef, useState } from 'react';
import { X, type Icon as PhosphorIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { HarnessSettingsEntry, HarnessSettingsResponse, OpencodeCatalogEntry, OpencodeModel } from '../../api/types';
import { HARNESSES, defaultModeFor, type Harness } from '../../lib/harnesses';
import { DEFAULT_AUTO_ARCHIVE_MS, toDuration, fromDuration, type DurationUnit } from '../../lib/autoArchive';
import {
  Toggle, SettingsPage, SettingsGroup, SettingsRow, SettingsSubPage, StatusMark,
  ghostBtn, solidBtn, fieldFor, miniChip, noteText,
} from './ui';
import { useSettings } from '../../stores/settings';
import { SpinnerWordsField } from './SpinnerWordsField';
import { useSpinnerWords } from '../../stores/spinnerWords';
import { Select } from '../common/Select';
import { Segmented } from '../common/Segmented';
import { HARNESS_MARK } from '../common/HarnessStrip';
import { useSubPage, scrollParentToTop } from './subPageNav';
import { useIsMobile } from '../../hooks/useIsMobile';

/**
 * Settings → Agents (formerly Harnesses), redesigned 2026-11-07 (docs/design/settings-layout.md):
 * the Control Plane's name, then one row per harness that opens the harness's own page. All of it
 * is the same on every device. Per-harness defaults are stored on the DAEMON (not localStorage)
 * because spawn-time behavior depends on them: the opencode key secret resolves on respawn after a
 * daemon restart with no browser anywhere in the loop. Only settings that act are offered: default
 * model (all), default mode (the two-mode harnesses), auto-archive (all); Claude Code's "Skip agent
 * status summaries" (on unless turned off) and working words; and for OpenCode the MODEL LIST the
 * New Thread picker offers (curated from OpenRouter's catalog) and the Doppler secret NAME holding
 * the OpenRouter key (the Dictation section's "your key stays in Doppler" pattern), with a
 * present/missing check and a replace-key field.
 */

/** `openrouter/vendor/model` → `vendor/model`, the part worth reading. */
const shortId = (id: string) => (id.startsWith('openrouter/') ? id.slice('openrouter/'.length) : id);
const formatContext = (n: number | null) => (n ? `${Math.round(n / 1000)}k context` : '');
const MODE_LABEL = { cli: 'CLI', pretty: 'Pretty' } as const;
const mono: React.CSSProperties = { font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const errText: React.CSSProperties = { fontSize: 12, color: 'var(--color-status-red)' };
/** The brand mark in the settings icon tile (IconTile draws any component that takes a `size`). */
const markOf = (h: Harness) => HARNESS_MARK[h.id] as unknown as PhosphorIcon;

/** "12 hours", "1 day": an auto-archive deadline in words. */
function archiveWords(ms: number): string {
  const { value, unit } = toDuration(ms);
  return `${value} ${value === 1 ? unit.replace(/s$/, '') : unit}`;
}

/** The models a harness offers: OpenCode's list is the curated setting, the others ship theirs. */
function modelsOf(h: Harness, data: HarnessSettingsResponse): { label: string; model: string | null }[] {
  // The `?? []` covers a browser that refreshed onto this bundle before the daemon restarted onto the route that serves the list.
  return h.id === 'opencode' ? data.opencodeModels ?? [] : h.models;
}

/** The row's value: the default model's name. OpenCode always pins a real model, so its "unset" is the first of its list. */
function modelValue(h: Harness, s: HarnessSettingsEntry, data: HarnessSettingsResponse): string {
  const models = modelsOf(h, data);
  if (!s.defaultModel) return h.id === 'opencode' ? models[0]?.label ?? 'None' : 'Default';
  return models.find((m) => m.model === s.defaultModel)?.label ?? shortId(s.defaultModel);
}

/** The row's one line: how new threads open, the archive deadline, OpenCode's list size. */
function rowHint(h: Harness, s: HarnessSettingsEntry, data: HarnessSettingsResponse): React.ReactNode {
  if (h.id === 'opencode' && !data.opencodeKey.present) return <StatusMark tone="yellow">No OpenRouter key yet</StatusMark>;
  const parts = [
    h.modes.length > 1 ? `Opens in ${MODE_LABEL[s.defaultMode ?? defaultModeFor(h)]}` : `${MODE_LABEL[h.modes[0]]} only`,
    s.autoArchiveMs !== undefined ? `archives after ${archiveWords(s.autoArchiveMs)}` : null,
    h.id === 'opencode' ? `${(data.opencodeModels ?? []).length} models` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function AgentsSection() {
  const nav = useSubPage('agents');
  const [data, setData] = useState<HarnessSettingsResponse | null>(null);
  const [err, setErr] = useState('');
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getHarnessSettings().then(setData).catch(() => setErr('Could not load the agent settings.'));
  }, []);
  useEffect(() => { scrollParentToTop(top.current); }, [nav.openId]);

  async function put(patch: Parameters<typeof api.putHarnessSettings>[0]) {
    try {
      const next = await api.putHarnessSettings(patch);
      setData(next); setErr('');
      useSpinnerWords.getState().set(next.settings?.['claude-code']?.spinnerVerbs ?? null);
    } catch { setErr('Could not save. Is the daemon reachable?'); }
  }

  const agents = HARNESSES.filter((h) => h.provider !== null);
  const open = data && nav.openId ? agents.find((h) => h.id === nav.openId) : undefined;

  if (open && data) {
    return (
      <div ref={top}>
        <HarnessPage h={open} data={data} err={err} put={put} setData={setData} setErr={setErr} onBack={nav.isMobile ? undefined : nav.close} />
      </div>
    );
  }

  return (
    <div ref={top}>
      <SettingsPage intro="Defaults for new threads, the same on every device.">
        <ControlPlaneName />
        <SettingsGroup title="Harnesses" footer={err ? <span role="alert" style={errText}>{err}</span> : undefined}>
          {!data
            ? <SettingsRow label={err ? 'Not loaded' : 'Loading…'} />
            : agents.map((h) => {
              const s = data.settings[h.type] ?? {};
              return (
                <SettingsRow key={h.id} icon={markOf(h)} label={h.label} ariaLabel={h.label}
                  hint={rowHint(h, s, data)} value={modelValue(h, s, data)} onClick={() => nav.open(h.id)} />
              );
            })}
        </SettingsGroup>
      </SettingsPage>
    </div>
  );
}

/** The coordinator's display name (daemon-stored, see stores/settings.ts loadSharedSettings). */
function ControlPlaneName() {
  const coordinatorName = useSettings((s) => s.coordinatorName);
  const isMobile = useIsMobile();
  return (
    <SettingsGroup title="Control Plane">
      <SettingsRow label="Name" hint="Shown wherever your coordinator appears. Leave it blank for “Control Plane”.">
        <input
          id="control-plane-name"
          value={coordinatorName}
          onChange={(e) => useSettings.getState().setCoordinatorName(e.target.value)}
          placeholder="Control Plane"
          aria-label="Control Plane name"
          maxLength={60}
          style={{ ...fieldFor(isMobile), width: '100%', maxWidth: isMobile ? undefined : 360, boxSizing: 'border-box' }}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** One harness's page: its defaults for new threads, then what only it has. */
function HarnessPage({ h, data, err, put, setData, setErr, onBack }: {
  h: Harness; data: HarnessSettingsResponse; err: string;
  put: (patch: Parameters<typeof api.putHarnessSettings>[0]) => Promise<void>;
  setData: (d: HarnessSettingsResponse) => void; setErr: (e: string) => void;
  onBack?: () => void;
}) {
  const s = data.settings[h.type] ?? {};
  const models = modelsOf(h, data);
  const isMobile = onBack === undefined;
  const autoDefault = MODE_LABEL[defaultModeFor(h)];
  return (
    <SettingsSubPage testId={`agent-detail-${h.id}`} icon={markOf(h)} title={h.label}
      subtitle={h.modes.length > 1 ? 'CLI and Pretty threads' : `${MODE_LABEL[h.modes[0]]} threads`}
      description="What a new thread of this harness starts with. You can change each one in the New Thread window."
      backLabel="Agents" onBack={onBack}>
      {err && <div role="alert" style={errText}>{err}</div>}

      <SettingsGroup title="New threads">
        <SettingsRow label="Default model">
          <Select
            id={`hm-${h.id}`}
            ariaLabel="Default model"
            style={{ width: '100%', maxWidth: isMobile ? undefined : 320 }}
            value={s.defaultModel ?? ''}
            onChange={(v) => void put({ [h.type]: { defaultModel: v || null } })}
            options={[
              { value: '', label: h.id === 'opencode' ? `List default (${models[0]?.label ?? '—'})` : 'Harness default' },
              ...models.filter((m) => m.model !== null).map((m) => ({ value: m.model!, label: m.label })),
            ]}
          />
        </SettingsRow>
        {h.modes.length > 1 && (
          <SettingsRow label="Default mode">
            <Segmented
              ariaLabel="Default mode"
              value={s.defaultMode ?? ''}
              onChange={(v) => void put({ [h.type]: { defaultMode: (v || null) as 'cli' | 'pretty' | null } })}
              options={[
                { value: '', label: 'No preference', hint: `New threads open in ${autoDefault}.` },
                { value: 'cli', label: 'CLI', hint: 'The terminal, as the CLI draws it.' },
                { value: 'pretty', label: 'Pretty', hint: 'The chat view.' },
              ]}
            />
          </SettingsRow>
        )}
        <AutoArchiveRow ms={s.autoArchiveMs} isMobile={isMobile}
          onChange={(on, ms) => void put({ [h.type]: { autoArchiveMs: on ? ms : null } })} />
      </SettingsGroup>

      {h.type === 'claude-code' && (
        <SettingsGroup title="While Claude works">
          <SettingsRow label="Skip agent status summaries"
            hint="Saves the tokens Claude spends on a background agent's status line. The line stops updating. New threads only."
            control={
              <Toggle on={s.skipAgentSummaries ?? true} label="Skip agent status summaries"
                onClick={() => void put({ 'claude-code': { skipAgentSummaries: !(s.skipAgentSummaries ?? true) } })} />
            } />
          <SpinnerWordsField value={s.spinnerVerbs} onSave={(v) => void put({ 'claude-code': { spinnerVerbs: v } })}
            sets={s.spinnerSets ?? []} onSaveSets={(sets) => void put({ 'claude-code': { spinnerSets: sets } })} />
        </SettingsGroup>
      )}

      {h.id === 'opencode' && (
        <>
          <OpencodeModelList
            models={data.opencodeModels ?? []}
            defaultModel={s.defaultModel}
            isMobile={isMobile}
            onSave={(next, clearDefault) => void put({ opencode: { models: next, ...(clearDefault ? { defaultModel: null } : {}) } })}
            onReset={() => void put({ opencode: { models: null } })}
          />
          <OpenRouterKey data={data} isMobile={isMobile} put={put} setData={setData} setErr={setErr} />
        </>
      )}
    </SettingsSubPage>
  );
}

const UNITS: DurationUnit[] = ['minutes', 'hours', 'days'];

/**
 * Auto-archive as a settings row: the switch, and when on, the deadline under it. Off unless set:
 * the New Thread window then opens with auto-archive on at this deadline. The same stored ms as
 * the New Thread window's AutoArchiveField; the unit picker only changes how it reads.
 */
function AutoArchiveRow({ ms, isMobile, onChange }: { ms: number | undefined; isMobile: boolean; onChange: (on: boolean, ms: number) => void }) {
  const enabled = ms !== undefined;
  const { value, unit } = toDuration(ms || DEFAULT_AUTO_ARCHIVE_MS);
  return (
    <SettingsRow label="Auto-archive" hint="Archive a new thread once it sits idle. Never while it works or waits on you."
      control={<Toggle on={enabled} label="Auto-archive thread" onClick={() => onChange(!enabled, ms || DEFAULT_AUTO_ARCHIVE_MS)} />}>
      {enabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>After</span>
          <input type="number" min={1} step={1} aria-label="Inactivity before archiving" value={value}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) onChange(true, fromDuration(n, unit)); }}
            style={{ ...fieldFor(isMobile), width: 70, boxSizing: 'border-box', fontFamily: 'var(--font-mono)' }} />
          <Select ariaLabel="Inactivity unit" value={unit} style={{ width: 110 }}
            options={UNITS.map((u) => ({ value: u, label: u }))}
            onChange={(v) => onChange(true, fromDuration(value, v as DurationUnit))} />
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>of no activity</span>
        </div>
      )}
    </SettingsRow>
  );
}

/** OpenCode's key: which Doppler secret holds it, whether it has a value, and a field to replace it. */
function OpenRouterKey({ data, isMobile, put, setData, setErr }: {
  data: HarnessSettingsResponse; isMobile: boolean;
  put: (patch: Parameters<typeof api.putHarnessSettings>[0]) => Promise<void>;
  setData: (d: HarnessSettingsResponse) => void; setErr: (e: string) => void;
}) {
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [secretsErr, setSecretsErr] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  useEffect(() => {
    api.listSecrets().then((s) => setSecretNames(s.map((x) => x.name)))
      .catch(() => setSecretsErr('Connect Doppler in Settings → Secrets to pick another secret.'));
  }, []);

  async function saveKey() {
    if (keySaving || !keyDraft.trim()) return;
    setKeySaving(true);
    try {
      await api.setSecret({ name: data.opencodeKey.secret, value: keyDraft.trim() });
      setKeyDraft('');
      setData(await api.getHarnessSettings());
      setErr('');
    } catch {
      setErr('Could not save the key. Doppler may be read-only or disconnected.');
    }
    setKeySaving(false);
  }
  const canSave = !keySaving && !!keyDraft.trim();

  return (
    <SettingsGroup title="OpenRouter key"
      footer={secretsErr ? <span style={{ color: 'var(--color-status-yellow)' }}>{secretsErr}</span> : 'The key stays in Doppler. Dispatch keeps only the name of the secret.'}>
      <SettingsRow label="Doppler secret">
        {/* The current name always shows, even when the secrets list failed to load. */}
        <Select id="oc-secret" ariaLabel="OpenRouter key secret" style={{ width: '100%', maxWidth: isMobile ? undefined : 320 }}
          value={data.opencodeKey.secret}
          onChange={(v) => void put({ opencode: { keySecret: v || null } })}
          options={[...(secretNames.includes(data.opencodeKey.secret) ? [] : [data.opencodeKey.secret]), ...secretNames].map((n) => ({ value: n, label: n }))} />
      </SettingsRow>
      <SettingsRow label="Key" hint={data.opencodeKey.present ? 'New threads get it when they start.' : 'Paste a key below to save it in this secret.'}
        control={data.opencodeKey.present ? <StatusMark tone="accent">Found</StatusMark> : <StatusMark tone="yellow">No value yet</StatusMark>} />
      <SettingsRow label={data.opencodeKey.present ? 'Replace the key' : 'Add the key'}>
        <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
          <input type="password" aria-label="New OpenRouter key" placeholder="sk-or-v1-…" value={keyDraft} autoComplete="off"
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
            style={{ ...fieldFor(isMobile), flex: 1, minWidth: 0, boxSizing: 'border-box', fontFamily: 'var(--font-mono)' }} />
          <button type="button" aria-label="Save key" disabled={!canSave} onClick={() => void saveKey()}
            style={{ ...solidBtn(canSave), height: isMobile ? 36 : 30 }}>{keySaving ? 'Saving…' : 'Save'}</button>
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}

const listReset: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const hairline = (i: number): React.CSSProperties => ({ borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' });
const iconX: React.CSSProperties = { width: 28, height: 28, padding: 0, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-tertiary)', cursor: 'pointer' };

/**
 * The OpenCode picker list: the rows you have, a catalog search to add more, a reset.
 * Saves the WHOLE list on every change (the daemon stores it whole), so the parent just
 * re-renders from the response.
 */
function OpencodeModelList({ models, defaultModel, isMobile, onSave, onReset }: {
  models: OpencodeModel[];
  defaultModel?: string;
  isMobile: boolean;
  onSave: (next: OpencodeModel[], clearDefault: boolean) => void;
  onReset: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OpencodeCatalogEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');
  const seq = useRef(0);

  // Debounced catalog search; stale responses (an older query resolving late) are dropped.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults(null); setSearchErr(''); setSearching(false); return; }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      api.searchOpencodeCatalog(q)
        .then((r) => { if (seq.current === mine) { setResults(r); setSearchErr(''); } })
        .catch((e: unknown) => { if (seq.current === mine) { setResults([]); setSearchErr(e instanceof Error ? e.message : 'Catalog search failed.'); } })
        .finally(() => { if (seq.current === mine) setSearching(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const have = new Set(models.map((m) => m.model));
  const add = (m: OpencodeModel) => { if (!have.has(m.model)) onSave([...models, m], false); };
  const remove = (id: string) => onSave(models.filter((m) => m.model !== id), id === defaultModel);
  const typed = query.trim();
  // A typed id the catalog does not know (a brand-new model, a non-OpenRouter provider):
  // let it through as long as it is shaped like an OpenCode id.
  const typedIsId = /^[\w.~-]+\/[\w.~-]+(\/[\w.~:-]+)?$/.test(typed) && !have.has(typed);
  const typedMatched = results?.some((r) => r.id === typed) ?? false;

  return (
    <SettingsGroup title="Models in the picker"
      action={<button type="button" onClick={onReset} style={{ ...ghostBtn, height: 26 }}>Reset to defaults</button>}
      footer="The New Thread window offers these models, in this order.">
      <ul aria-label="OpenCode models" style={listReset}>
        {models.map((m, i) => (
          <li key={m.model} style={hairline(i)}>
            <SettingsRow style={{ padding: '7px 6px 7px 12px' }} label={m.label}
              value={<span style={{ ...mono, display: 'block' }}>{shortId(m.model)}</span>}
              control={
                <button type="button" aria-label={`Remove ${m.label}`} title="Remove" onClick={() => remove(m.model)} style={iconX}>
                  <X size={13} weight="bold" />
                </button>
              } />
          </li>
        ))}
        {models.length === 0 && <li style={{ ...noteText, padding: '11px 12px' }}>No models. Add one below, or reset to the defaults.</li>}
      </ul>
      <SettingsRow label="Add a model">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search OpenRouter: grok, gemini flash, deepseek"
          aria-label="Add a model"
          autoComplete="off"
          spellCheck={false}
          style={{ ...fieldFor(isMobile), width: '100%', boxSizing: 'border-box' }}
        />
        {searchErr && <div style={{ fontSize: 12, color: 'var(--color-status-yellow)' }}>{searchErr}</div>}
        {typed && !searchErr && (
          <ul aria-label="Catalog results" style={{ ...listReset, display: 'flex', flexDirection: 'column', maxHeight: 300, overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
            {searching && results === null && <li style={{ ...noteText, padding: '8px 10px' }}>Searching…</li>}
            {results?.map((r, i) => {
              const added = have.has(r.id);
              return (
                <li key={r.id} style={{ ...hairline(i), display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px 7px 10px' }}>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 13, color: 'var(--color-text-primary)' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                      {r.alias && <span style={{ ...miniChip, color: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}>Latest</span>}
                      {r.tools === false && (
                        // No endpoint takes a tool list, so Dispatch runs it with every tool off: it can
                        // chat, but not run commands, touch files, or reach the peer tools.
                        <span title="No tool calling: the thread can chat but cannot run commands, edit files, or use peer tools."
                          style={{ ...miniChip, color: 'var(--color-status-yellow)', borderColor: 'var(--color-status-yellow)' }}>Chat only</span>
                      )}
                    </span>
                    <span style={mono}>{shortId(r.id)}{r.aliasTarget ? ` → ${r.aliasTarget}` : ''}{r.contextLength ? ` · ${formatContext(r.contextLength)}` : ''}</span>
                  </span>
                  {added
                    ? <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', flex: 'none' }}>Added</span>
                    : <button type="button" aria-label={`Add ${r.label}`} onClick={() => add({ label: r.label, model: r.id })} style={{ ...ghostBtn, height: 28 }}>Add</button>}
                </li>
              );
            })}
            {results && results.length === 0 && !typedIsId && <li style={{ ...noteText, padding: '8px 10px' }}>No catalog match.</li>}
            {results && typedIsId && !typedMatched && (
              <li style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px 7px 10px', borderTop: results.length ? '1px solid var(--color-border)' : 'none' }}>
                <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', flex: 1, minWidth: 0 }}>Not in the catalog. Add it anyway?</span>
                <button type="button" aria-label={`Add ${typed} as typed`} onClick={() => add({ label: shortId(typed), model: typed })} style={{ ...ghostBtn, height: 28 }}>Add as typed</button>
              </li>
            )}
          </ul>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}
