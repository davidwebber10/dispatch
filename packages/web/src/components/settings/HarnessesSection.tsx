import { useEffect, useRef, useState } from 'react';
import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { HarnessSettingsResponse, OpencodeCatalogEntry, OpencodeModel } from '../../api/types';
import { HARNESSES } from '../../lib/harnesses';

/**
 * Per-harness defaults, stored on the DAEMON (not localStorage) because spawn-time
 * behavior depends on them: the opencode key secret resolves on respawn after a daemon
 * restart with no browser anywhere in the loop. Only settings that act are offered:
 * default model (all), default mode (the two-mode harnesses), and for OpenCode the
 * Doppler secret NAME holding the OpenRouter key — the transcription section's "your key
 * stays in Doppler" pattern, plus a live present/missing check and a replace-key field —
 * and the MODEL LIST the New Thread picker offers, curated from OpenRouter's catalog.
 */

const label = { fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--color-text-tertiary)' } as const;
const selectStyle = {
  height: 34, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13, minWidth: 200,
} as const;
const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } as const;
const cardStyle = {
  display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px',
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 10,
} as const;
const mono = { font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
const ghostButton = {
  height: 28, padding: '0 10px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 7,
  color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer',
} as const;

/** `openrouter/vendor/model` → `vendor/model`, the part worth reading. */
const shortId = (id: string) => (id.startsWith('openrouter/') ? id.slice('openrouter/'.length) : id);
const formatContext = (n: number | null) => (n ? `${Math.round(n / 1000)}k ctx` : '');

export function HarnessesSection() {
  const [data, setData] = useState<HarnessSettingsResponse | null>(null);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [secretsErr, setSecretsErr] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.getHarnessSettings().then(setData).catch(() => setErr('Could not load harness settings.'));
    api.listSecrets().then((s) => setSecretNames(s.map((x) => x.name)))
      .catch(() => setSecretsErr('Connect Doppler in the Secrets tab to choose a key secret.'));
  }, []);

  async function put(patch: Parameters<typeof api.putHarnessSettings>[0]) {
    try { setData(await api.putHarnessSettings(patch)); setErr(''); }
    catch { setErr('Could not save — is the daemon reachable?'); }
  }

  async function saveKey() {
    if (!data || keySaving || !keyDraft.trim()) return;
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

  if (!data) return <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{err || 'Loading…'}</div>;

  const agents = HARNESSES.filter((h) => h.provider !== null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
        Defaults applied when you open the New Thread modal. The OpenRouter key itself stays in
        Doppler — Dispatch only stores which secret to use.
      </div>
      {err && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}

      {agents.map((h) => {
        const s = data.settings[h.type] ?? {};
        const twoModes = h.modes.length > 1;
        // OpenCode's list is the curated setting; the other harnesses ship theirs. The
        // `?? []` covers a browser that refreshed onto this bundle before the daemon
        // restarted onto the route that serves the list.
        const models: { label: string; model: string | null }[] = h.id === 'opencode' ? data.opencodeModels ?? [] : h.models;
        return (
          <div key={h.id} style={cardStyle}>
            <span style={label}>{h.label.toUpperCase()}</span>

            <div style={rowStyle}>
              <label htmlFor={`hm-${h.id}`} style={{ fontSize: 13 }}>Default model</label>
              <select
                id={`hm-${h.id}`}
                style={selectStyle}
                value={s.defaultModel ?? ''}
                onChange={(e) => void put({ [h.type]: { defaultModel: e.target.value || null } })}
              >
                {/* OpenCode always pins a real model, so its "unset" reads as the first of its list. */}
                <option value="">{h.id === 'opencode' ? `List default (${models[0]?.label ?? '—'})` : 'Harness default'}</option>
                {models.filter((m) => m.model !== null).map((m) => (
                  <option key={m.model} value={m.model!}>{m.label}</option>
                ))}
              </select>
            </div>

            {twoModes && (
              <div style={rowStyle}>
                <label htmlFor={`hmode-${h.id}`} style={{ fontSize: 13 }}>Default mode</label>
                <select
                  id={`hmode-${h.id}`}
                  style={selectStyle}
                  value={s.defaultMode ?? ''}
                  onChange={(e) => void put({ [h.type]: { defaultMode: e.target.value || null } })}
                >
                  <option value="">No preference</option>
                  <option value="cli">CLI</option>
                  <option value="pretty">Pretty</option>
                </select>
              </div>
            )}

            {h.id === 'opencode' && (
              <>
                <OpencodeModelList
                  models={data.opencodeModels ?? []}
                  defaultModel={s.defaultModel}
                  onSave={(next, clearDefault) => void put({ opencode: { models: next, ...(clearDefault ? { defaultModel: null } : {}) } })}
                  onReset={() => void put({ opencode: { models: null } })}
                />

                <div style={rowStyle}>
                  <label htmlFor="oc-secret" style={{ fontSize: 13 }}>OpenRouter key (Doppler secret)</label>
                  <select
                    id="oc-secret"
                    style={selectStyle}
                    value={data.opencodeKey.secret}
                    onChange={(e) => void put({ opencode: { keySecret: e.target.value || null } })}
                  >
                    {/* The current name always renders, even when the secrets list failed to load. */}
                    {!secretNames.includes(data.opencodeKey.secret) && (
                      <option value={data.opencodeKey.secret}>{data.opencodeKey.secret}</option>
                    )}
                    {secretNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  {data.opencodeKey.present
                    ? (<><CheckCircle size={14} weight="fill" color="var(--color-accent)" /> <span style={{ color: 'var(--color-text-secondary)' }}>Key found — applied on the next thread spawn.</span></>)
                    : (<><WarningCircle size={14} weight="fill" color="var(--color-status-yellow)" /> <span style={{ color: 'var(--color-text-secondary)' }}>No value in this secret yet.</span></>)}
                </div>
                <div style={rowStyle}>
                  <input
                    type="password"
                    placeholder={data.opencodeKey.present ? 'Replace key…' : 'sk-or-v1-…'}
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    style={{ ...selectStyle, flex: 1, minWidth: 0, font: '400 12px var(--font-mono)' }}
                  />
                  <button
                    type="button"
                    disabled={keySaving || !keyDraft.trim()}
                    onClick={() => void saveKey()}
                    style={{ height: 34, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 8, color: '#08240F', fontWeight: 600, fontSize: 12.5, cursor: keySaving || !keyDraft.trim() ? 'default' : 'pointer', opacity: keySaving || !keyDraft.trim() ? 0.6 : 1 }}
                  >
                    {keySaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
                {secretsErr && <div style={{ fontSize: 11.5, color: 'var(--color-status-yellow)' }}>{secretsErr}</div>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The OpenCode picker list: the rows you have, a catalog search to add more, a reset.
 * Saves the WHOLE list on every change (the daemon stores it whole), so the parent just
 * re-renders from the response.
 */
function OpencodeModelList({ models, defaultModel, onSave, onReset }: {
  models: OpencodeModel[];
  defaultModel?: string;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 }}>
      <div style={rowStyle}>
        <span style={{ fontSize: 13 }}>Models in the picker</span>
        <button type="button" onClick={onReset} style={ghostButton}>Reset to defaults</button>
      </div>
      <ul aria-label="OpenCode models" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {models.map((m) => (
          <li key={m.model} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 30, padding: '3px 6px 3px 10px', background: 'rgba(0,0,0,.18)', border: '1px solid var(--color-border)', borderRadius: 7 }}>
            {/* One line per model: the list is long, so the label and id sit side by side. */}
            <span style={{ fontSize: 12.5, color: 'var(--color-text-primary)', flex: '0 0 150px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
            <span style={{ ...mono, flex: 1, minWidth: 0 }}>{shortId(m.model)}</span>
            <button type="button" aria-label={`Remove ${m.label}`} title="Remove" onClick={() => remove(m.model)}
              style={{ width: 24, height: 24, padding: 0, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 5, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>
              <X size={12} weight="bold" />
            </button>
          </li>
        ))}
      </ul>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Add a model — search OpenRouter (e.g. grok, gemini flash, deepseek)"
        aria-label="Add a model"
        autoComplete="off"
        spellCheck={false}
        style={{ ...selectStyle, minWidth: 0, width: '100%', boxSizing: 'border-box', fontSize: 12.5 }}
      />
      {searchErr && <div style={{ fontSize: 11.5, color: 'var(--color-status-yellow)' }}>{searchErr}</div>}
      {typed && !searchErr && (
        <ul aria-label="Catalog results" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 260, overflowY: 'auto' }}>
          {searching && results === null && (
            <li style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '4px 2px' }}>Searching…</li>
          )}
          {results?.map((r) => {
            const added = have.has(r.id);
            return (
              <li key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 8px 5px 10px', borderRadius: 7, border: '1px solid transparent' }}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}>
                    {r.label}
                    {r.alias && <span style={{ marginLeft: 6, font: '600 9.5px var(--font-mono)', letterSpacing: '.05em', color: 'var(--color-accent)' }}>LATEST</span>}
                  </span>
                  <span style={mono}>{shortId(r.id)}{r.aliasTarget ? ` → ${r.aliasTarget}` : ''}{r.contextLength ? ` · ${formatContext(r.contextLength)}` : ''}</span>
                </span>
                {added
                  ? <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', flex: 'none' }}>Added</span>
                  : <button type="button" aria-label={`Add ${r.label}`} onClick={() => add({ label: r.label, model: r.id })} style={ghostButton}>Add</button>}
              </li>
            );
          })}
          {results && results.length === 0 && !typedIsId && (
            <li style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '4px 2px' }}>No catalog match.</li>
          )}
          {results && typedIsId && !typedMatched && (
            <li style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 8px 5px 10px' }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: 1, minWidth: 0 }}>Not in the catalog. Add it anyway?</span>
              <button type="button" aria-label={`Add ${typed} as typed`} onClick={() => add({ label: shortId(typed), model: typed })} style={ghostButton}>Add as typed</button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
