import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DictationSection } from './DictationSection';
import { useSettings } from '../../stores/settings';

const { put } = vi.hoisted(() => ({ put: vi.fn().mockResolvedValue({ saved: true }) }));
vi.mock('../../api/client', () => ({
  api: { listSecrets: vi.fn().mockResolvedValue([{ name: 'GROQ_API_KEY', value: 'x' }, { name: 'OPENAI_API_KEY', value: 'y' }]), putDictationSettings: (...a: unknown[]) => put(...a) },
}));

beforeEach(() => { put.mockClear(); try { localStorage.clear(); } catch {} useSettings.setState({ sttProvider: 'groq', sttModel: 'whisper-large-v3-turbo', sttSecretName: '' }); });

it('lists Doppler secret names and updates the store on select', async () => {
  render(<DictationSection />);
  await waitFor(() => expect(screen.getByText('GROQ_API_KEY')).toBeInTheDocument());
  const secretSelect = screen.getByLabelText(/API key/i);
  fireEvent.change(secretSelect, { target: { value: 'OPENAI_API_KEY' } });
  expect(useSettings.getState().sttSecretName).toBe('OPENAI_API_KEY');
});

it('changing provider resets the model to that provider first model', () => {
  render(<DictationSection />);
  fireEvent.change(screen.getByLabelText(/Provider/i), { target: { value: 'openai' } });
  expect(useSettings.getState().sttProvider).toBe('openai');
  expect(useSettings.getState().sttModel).toBe('gpt-4o-mini-transcribe');
});

it('saves each change to the daemon (the same on every device)', () => {
  render(<DictationSection />);
  fireEvent.change(screen.getByLabelText(/Provider/i), { target: { value: 'openai' } });
  expect(put).toHaveBeenCalledWith({ provider: 'openai' });
  expect(put).toHaveBeenCalledWith({ model: 'gpt-4o-mini-transcribe' });
});

it('does not say dictation is mobile only', () => {
  render(<DictationSection />);
  expect(screen.queryByText(/on mobile/i)).toBeNull();
  expect(screen.getByText('ALL DEVICES')).toBeInTheDocument();
});
