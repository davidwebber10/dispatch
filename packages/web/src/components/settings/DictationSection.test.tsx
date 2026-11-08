import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DictationSection } from './DictationSection';
import { useSettings } from '../../stores/settings';
import { pickOption } from '../../test/select';

const { put, listSecrets } = vi.hoisted(() => ({ put: vi.fn().mockResolvedValue({ saved: true }), listSecrets: vi.fn() }));
vi.mock('../../api/client', () => ({
  api: { listSecrets: (...a: unknown[]) => listSecrets(...a), putDictationSettings: (...a: unknown[]) => put(...a) },
}));

beforeEach(() => { put.mockClear(); listSecrets.mockReset(); listSecrets.mockResolvedValue([{ name: 'GROQ_API_KEY', value: 'x' }, { name: 'OPENAI_API_KEY', value: 'y' }]); try { localStorage.clear(); } catch {} useSettings.setState({ sttProvider: 'groq', sttModel: 'whisper-large-v3-turbo', sttSecretName: '' }); });

it('lists Doppler secret names and updates the store on select', async () => {
  render(<DictationSection />);
  fireEvent.click(screen.getByRole('combobox', { name: /API key/i }));
  await waitFor(() => expect(screen.getByRole('option', { name: 'GROQ_API_KEY' })).toBeInTheDocument());
  pickOption(/API key/i, 'OPENAI_API_KEY');
  expect(useSettings.getState().sttSecretName).toBe('OPENAI_API_KEY');
});

it('changing provider resets the model to that provider first model', () => {
  render(<DictationSection />);
  pickOption(/Provider/i, /^OpenAI/);
  expect(useSettings.getState().sttProvider).toBe('openai');
  expect(useSettings.getState().sttModel).toBe('gpt-4o-mini-transcribe');
});

it('saves each change to the daemon (the same on every device)', () => {
  render(<DictationSection />);
  pickOption(/Provider/i, /^OpenAI/);
  expect(put).toHaveBeenCalledWith({ provider: 'openai' });
  expect(put).toHaveBeenCalledWith({ model: 'gpt-4o-mini-transcribe' });
});

it('does not say dictation is mobile only', () => {
  render(<DictationSection />);
  expect(screen.queryByText(/on mobile/i)).toBeNull();
  expect(screen.getByTestId('settings-intro').textContent).toMatch(/every device/i);
});

it('groups provider, model and key in one card, and recordings in another', () => {
  render(<DictationSection />);
  const stt = screen.getByRole('group', { name: 'Speech to text' });
  for (const name of [/Provider/i, /Model/i, /API key/i]) expect(within(stt).getByRole('combobox', { name })).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'This device' })).getByRole('button', { name: /^Recordings/ })).toBeInTheDocument();
});

it('without Doppler: the key row shows a status and opens Settings → Secrets', async () => {
  listSecrets.mockRejectedValue(new Error('no doppler'));
  const { useUI } = await import('../../stores/ui');
  const requestSettings = vi.fn();
  useUI.setState({ requestSettings } as never);
  render(<DictationSection />);
  const mark = await screen.findByTestId('status-mark');
  expect(mark.textContent).toMatch(/Doppler is not connected/);
  expect(screen.queryByRole('combobox', { name: /API key/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /API key/i }));
  expect(requestSettings).toHaveBeenCalledWith('secrets');
});

it('without Doppler, a saved secret name still shows', async () => {
  listSecrets.mockRejectedValue(new Error('no doppler'));
  useSettings.setState({ sttSecretName: 'GROQ_API_KEY' });
  render(<DictationSection />);
  await screen.findByTestId('status-mark');
  expect(screen.getByText('GROQ_API_KEY')).toBeInTheDocument();
});

describe('recent recordings (2026-11-07)', () => {
  it('Settings → Dictation opens the Recordings sheet', async () => {
    const rec = await import('../../lib/recordings');
    rec.setRecordingBackend(rec.memoryBackend());
    await rec.saveRecording({ mimeType: 'audio/webm', durationMs: 3000, status: 'done', text: 'kept words' }, new Blob(['a']));
    render(<DictationSection />);
    fireEvent.click(screen.getByRole('button', { name: /^Recordings/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Recordings' });
    expect(await within(sheet).findByText(/kept words/)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Insert' })).toBeNull();
  });
});
