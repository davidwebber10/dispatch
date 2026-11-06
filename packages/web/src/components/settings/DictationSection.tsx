import { useEffect, useState } from 'react';
import { useSettings } from '../../stores/settings';
import { PROVIDERS, getProvider } from '../../lib/transcription-providers';
import { api } from '../../api/client';
import { sectionLabel, summaryLine } from './ui';

const selectStyle = {
  height: 34, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13, minWidth: 200,
} as const;
const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } as const;

/**
 * Settings → Dictation: the speech-to-text provider, model and the Doppler secret holding its key,
 * for the mic in every composer (phone and desktop). The same on all devices: the daemon stores them
 * (stores/settings.ts loadSharedSettings); the key itself stays in Doppler.
 */
export function DictationSection() {
  const sttProvider = useSettings((s) => s.sttProvider);
  const sttModel = useSettings((s) => s.sttModel);
  const sttSecretName = useSettings((s) => s.sttSecretName);
  const { setSttProvider, setSttModel, setSttSecretName } = useSettings.getState();
  const [secrets, setSecrets] = useState<string[]>([]);
  const [secretsErr, setSecretsErr] = useState('');

  useEffect(() => {
    api.listSecrets().then((s) => setSecrets(s.map((x) => x.name)))
      .catch(() => setSecretsErr('Connect Doppler in Settings → Secrets.'));
  }, []);

  const provider = getProvider(sttProvider);

  function onProvider(id: string) {
    setSttProvider(id);
    const first = getProvider(id)?.models[0]?.id ?? '';
    setSttModel(first); // keep model valid for the new provider
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>ALL DEVICES</span>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Voice dictation from the mic in any composer, on a phone or a computer. Your API key stays in Doppler.
          Dispatch only stores which secret to use.
        </div>

        <div style={rowStyle}>
          <label htmlFor="stt-provider" style={{ fontSize: 13 }}>Provider</label>
          <select id="stt-provider" style={selectStyle} value={sttProvider} onChange={(e) => onProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id} disabled={p.status === 'coming-soon'}>
                {p.label}{p.status === 'coming-soon' ? ' (coming soon)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div style={rowStyle}>
          <label htmlFor="stt-model" style={{ fontSize: 13 }}>Model</label>
          <select id="stt-model" style={selectStyle} value={sttModel} onChange={(e) => setSttModel(e.target.value)}>
            {(provider?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>

        <div style={rowStyle}>
          <label htmlFor="stt-secret" style={{ fontSize: 13 }}>API key (Doppler secret)</label>
          <select id="stt-secret" style={selectStyle} value={sttSecretName} onChange={(e) => setSttSecretName(e.target.value)}>
            <option value="">— select a secret —</option>
            {/* The chosen name always renders, even when the secrets list failed to load. */}
            {sttSecretName && !secrets.includes(sttSecretName) && <option value={sttSecretName}>{sttSecretName}</option>}
            {secrets.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {secretsErr && <div style={{ fontSize: 11.5, color: 'var(--color-status-yellow)' }}>{secretsErr}</div>}
        <div style={summaryLine}>The same on every device: a change here applies to your phone and computers.</div>
      </div>
    </div>
  );
}
