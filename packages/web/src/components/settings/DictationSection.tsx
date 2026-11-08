import { useEffect, useState } from 'react';
import { useSettings } from '../../stores/settings';
import { useUI } from '../../stores/ui';
import { PROVIDERS, getProvider } from '../../lib/transcription-providers';
import { listRecordings } from '../../lib/recordings';
import { api } from '../../api/client';
import { SettingsPage, SettingsGroup, SettingsRow, StatusMark } from './ui';
import { RecordingsSheet } from '../dictation/RecordingsSheet';
import { Select } from '../common/Select';

/** One width for the three pickers, so their edges line up down the card. */
const pick: React.CSSProperties = { width: 220, maxWidth: '58vw' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12 };

/**
 * Settings → Dictation: the speech-to-text provider, model and the Doppler secret holding its key,
 * for the mic in every composer (phone and desktop). The same on all devices: the daemon stores them
 * (stores/settings.ts loadSharedSettings); the key itself stays in Doppler. The kept recordings are
 * this device's own (IndexedDB).
 */
export function DictationSection() {
  const sttProvider = useSettings((s) => s.sttProvider);
  const sttModel = useSettings((s) => s.sttModel);
  const sttSecretName = useSettings((s) => s.sttSecretName);
  const { setSttProvider, setSttModel, setSttSecretName } = useSettings.getState();
  const [secrets, setSecrets] = useState<string[]>([]);
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [noDoppler, setNoDoppler] = useState(false);
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const [recordingCount, setRecordingCount] = useState<number | null>(null);

  useEffect(() => {
    api.listSecrets().then((s) => { setSecrets(s.map((x) => x.name)); setSecretsLoaded(true); })
      .catch(() => setNoDoppler(true));
  }, []);
  // The count on the Recordings row; read again when the sheet closes (a recording may be gone).
  useEffect(() => {
    if (recordingsOpen) return;
    let alive = true;
    listRecordings().then((r) => { if (alive) setRecordingCount(r.length); }).catch(() => {});
    return () => { alive = false; };
  }, [recordingsOpen]);

  const provider = getProvider(sttProvider);

  function onProvider(id: string) {
    setSttProvider(id);
    const first = getProvider(id)?.models[0]?.id ?? '';
    setSttModel(first); // keep model valid for the new provider
  }

  const keyRow = noDoppler ? (
    <SettingsRow label="API key" ariaLabel="API key: connect Doppler in Secrets"
      hint={<StatusMark tone="yellow">Doppler is not connected. Open Secrets to connect it.</StatusMark>}
      value={sttSecretName ? <span style={mono}>{sttSecretName}</span> : undefined}
      onClick={() => useUI.getState().requestSettings('secrets')} />
  ) : (
    <SettingsRow label="API key"
      hint={secretsLoaded && secrets.length === 0 && !sttSecretName ? 'No secrets in Doppler yet. Add one in Secrets.' : 'The Doppler secret that holds the key.'}
      control={
        // The chosen name always shows, even when it is no longer in the list.
        <Select ariaLabel="API key" style={pick} value={sttSecretName} onChange={setSttSecretName} placeholder="Choose a secret"
          options={[...(sttSecretName && !secrets.includes(sttSecretName) ? [sttSecretName] : []), ...secrets].map((n) => ({ value: n, label: n }))} />
      } />
  );

  return (
    <SettingsPage intro="Speak into the mic in any composer. These choices apply on every device; the key stays in Doppler.">
      <SettingsGroup title="Speech to text">
        <SettingsRow label="Provider" control={
          <Select ariaLabel="Provider" style={pick} value={sttProvider} onChange={onProvider}
            options={PROVIDERS.map((p) => ({ value: p.id, label: `${p.label}${p.status === 'coming-soon' ? ' (coming soon)' : ''}`, disabled: p.status === 'coming-soon' }))} />
        } />
        <SettingsRow label="Model" control={
          <Select ariaLabel="Model" style={pick} value={sttModel} onChange={setSttModel}
            options={(provider?.models ?? []).map((m) => ({ value: m.id, label: m.label }))} />
        } />
        {keyRow}
      </SettingsGroup>

      <SettingsGroup title="This device">
        <SettingsRow label="Recordings" ariaLabel="Recordings"
          hint="Each dictation stays here until it is transcribed, so you can send a failed one again."
          value={recordingCount === null ? undefined : recordingCount === 0 ? 'None' : String(recordingCount)}
          onClick={() => setRecordingsOpen(true)} />
      </SettingsGroup>
      <RecordingsSheet open={recordingsOpen} onClose={() => setRecordingsOpen(false)} />
    </SettingsPage>
  );
}
