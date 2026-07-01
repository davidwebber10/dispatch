import { useEffect, useState } from 'react';
import { useSettings } from '../../stores/settings';
import { PROVIDERS, getProvider } from '../../lib/transcription-providers';
import { api } from '../../api/client';

const label = { fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--color-text-tertiary)' } as const;
const selectStyle = {
  height: 34, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13, minWidth: 200,
} as const;
const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } as const;

export function TranscriptionSection() {
  const { sttProvider, sttModel, sttSecretName, setSttProvider, setSttModel, setSttSecretName } = useSettings();
  const [secrets, setSecrets] = useState<string[]>([]);
  const [secretsErr, setSecretsErr] = useState('');

  useEffect(() => {
    api.listSecrets().then((s) => setSecrets(s.map((x) => x.name)))
      .catch(() => setSecretsErr('Connect Doppler in the Secrets tab to choose a key.'));
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
        <span style={label}>TRANSCRIPTION</span>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          Voice dictation on mobile. Your API key stays in Doppler — Dispatch only stores which secret to use.
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
            {secrets.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {secretsErr && <div style={{ fontSize: 11.5, color: 'var(--color-status-yellow)' }}>{secretsErr}</div>}
      </div>
    </div>
  );
}
