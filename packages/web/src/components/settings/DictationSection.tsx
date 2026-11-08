import { useEffect, useState } from 'react';
import { useSettings } from '../../stores/settings';
import { PROVIDERS, getProvider } from '../../lib/transcription-providers';
import { api } from '../../api/client';
import { sectionLabel, summaryLine, ghostBtn } from './ui';
import { RecordingsSheet } from '../dictation/RecordingsSheet';
import { Select } from '../common/Select';

const selectStyle = { height: 34, fontSize: 13, width: 'auto', minWidth: 200, maxWidth: 280 } as const;
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
  const [recordingsOpen, setRecordingsOpen] = useState(false);

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
          <Select id="stt-provider" style={selectStyle} value={sttProvider} onChange={onProvider}
            options={PROVIDERS.map((p) => ({ value: p.id, label: `${p.label}${p.status === 'coming-soon' ? ' (coming soon)' : ''}`, disabled: p.status === 'coming-soon' }))} />
        </div>

        <div style={rowStyle}>
          <label htmlFor="stt-model" style={{ fontSize: 13 }}>Model</label>
          <Select id="stt-model" style={selectStyle} value={sttModel} onChange={setSttModel}
            options={(provider?.models ?? []).map((m) => ({ value: m.id, label: m.label }))} />
        </div>

        <div style={rowStyle}>
          <label htmlFor="stt-secret" style={{ fontSize: 13 }}>API key (Doppler secret)</label>
          {/* The chosen name always shows, even when the secrets list failed to load. */}
          <Select id="stt-secret" style={selectStyle} value={sttSecretName} onChange={setSttSecretName} placeholder="Choose a secret"
            options={[...(sttSecretName && !secrets.includes(sttSecretName) ? [sttSecretName] : []), ...secrets].map((n) => ({ value: n, label: n }))} />
        </div>

        {secretsErr && <div style={{ fontSize: 11.5, color: 'var(--color-status-yellow)' }}>{secretsErr}</div>}
        <div style={summaryLine}>The same on every device: a change here applies to your phone and computers.</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
        <span style={sectionLabel}>THIS DEVICE</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" style={ghostBtn} onClick={() => setRecordingsOpen(true)}>Recent recordings</button>
          <span style={summaryLine}>Every dictation is kept here until it is transcribed, so a failed upload can be sent again.</span>
        </div>
      </div>
      <RecordingsSheet open={recordingsOpen} onClose={() => setRecordingsOpen(false)} />
    </div>
  );
}
