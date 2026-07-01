import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TranscriptionSection } from './TranscriptionSection';
import { useSettings } from '../../stores/settings';

vi.mock('../../api/client', () => ({
  api: { listSecrets: vi.fn().mockResolvedValue([{ name: 'GROQ_API_KEY', value: 'x' }, { name: 'OPENAI_API_KEY', value: 'y' }]) },
}));

beforeEach(() => { try { localStorage.clear(); } catch {} useSettings.setState({ sttProvider: 'groq', sttModel: 'whisper-large-v3-turbo', sttSecretName: '' }); });

it('lists Doppler secret names and updates the store on select', async () => {
  render(<TranscriptionSection />);
  await waitFor(() => expect(screen.getByText('GROQ_API_KEY')).toBeInTheDocument());
  const secretSelect = screen.getByLabelText(/API key/i);
  fireEvent.change(secretSelect, { target: { value: 'OPENAI_API_KEY' } });
  expect(useSettings.getState().sttSecretName).toBe('OPENAI_API_KEY');
});

it('changing provider resets the model to that provider first model', () => {
  render(<TranscriptionSection />);
  fireEvent.change(screen.getByLabelText(/Provider/i), { target: { value: 'openai' } });
  expect(useSettings.getState().sttProvider).toBe('openai');
  expect(useSettings.getState().sttModel).toBe('gpt-4o-mini-transcribe');
});
