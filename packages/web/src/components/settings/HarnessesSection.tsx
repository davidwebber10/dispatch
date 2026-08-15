import { useEffect, useState } from 'react';
import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { HarnessSettingsResponse } from '../../api/types';
import { HARNESSES } from '../../lib/harnesses';

/**
 * Per-harness defaults, stored on the DAEMON (not localStorage) because spawn-time
 * behavior depends on them: the opencode key secret resolves on respawn after a daemon
 * restart with no browser anywhere in the loop. Only settings that act are offered:
 * default model (all), default mode (the two-mode harnesses), and for OpenCode the
 * Doppler secret NAME holding the OpenRouter key — the transcription section's "your key
 * stays in Doppler" pattern, plus a live present/missing check and a replace-key field.
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
                {/* OpenCode always pins a real model, so its "unset" reads as the curated default. */}
                <option value="">{h.id === 'opencode' ? `Curated default (${h.models[0]?.label})` : 'Harness default'}</option>
                {h.models.filter((m) => m.model !== null).map((m) => (
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
