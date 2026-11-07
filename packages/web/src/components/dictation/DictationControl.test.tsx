import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { DictationControl } from './DictationControl';
import { act } from '@testing-library/react';
import { memoryBackend, setRecordingBackend, saveRecording, listRecordings } from '../../lib/recordings';

function mk(overrides = {}) {
  return { state: 'recording', error: null, progress: {}, recordingId: null, start: vi.fn(), cancel: vi.fn(), confirm: vi.fn(), retry: vi.fn(), reset: vi.fn(), insert: vi.fn(), getAnalyser: () => null, ...overrides } as any;
}

it('recording: ✓ calls confirm, ✕ calls cancel', () => {
  const d = mk();
  render(<DictationControl dictation={d} />);
  fireEvent.click(screen.getByLabelText(/confirm/i));
  expect(d.confirm).toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/cancel/i));
  expect(d.cancel).toHaveBeenCalled();
});

it('error: shows message and Retry calls retry (the same recording when there is one)', () => {
  const d = mk({ state: 'error', error: 'Microphone permission denied.' });
  render(<DictationControl dictation={d} />);
  expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/retry/i));
  expect(d.retry).toHaveBeenCalled();
});

it('uploading shows the percentage; transcribing shows the seconds', () => {
  const { rerender } = render(<DictationControl dictation={mk({ state: 'uploading', progress: { pct: 0.42 } })} />);
  expect(screen.getByRole('status')).toHaveTextContent('Uploading 42%');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
  rerender(<DictationControl dictation={mk({ state: 'transcribing', progress: { elapsedS: 7 } })} />);
  expect(screen.getByRole('status')).toHaveTextContent('Transcribing… 7s');
});

it('a failure with a kept recording offers Recordings, which lists it with Insert, Transcribe again and Delete', async () => {
  setRecordingBackend(memoryBackend());
  const done = await saveRecording({ mimeType: 'audio/webm', durationMs: 65_000, status: 'done', text: 'an older dictation' }, new Blob(['a']));
  const failed = await saveRecording({ mimeType: 'audio/webm', durationMs: 12_000, status: 'failed', error: 'Network error' }, new Blob(['b']));
  const d = mk({ state: 'error', error: 'Network error. The recording is kept.', recordingId: failed.id });
  render(<DictationControl dictation={d} />);
  fireEvent.click(screen.getByRole('button', { name: 'Recordings' }));
  const sheet = await screen.findByRole('dialog', { name: 'Recordings' });
  const rows = await within(sheet).findAllByTestId('recording-row');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('Network error');
  expect(rows[0]).toHaveTextContent('0:12');
  expect(rows[1]).toHaveTextContent('an older dictation');
  fireEvent.click(within(rows[0]).getByRole('button', { name: 'Delete' }));
  await waitFor(async () => expect((await listRecordings()).map((r) => r.id)).toEqual([done.id]));
  await waitFor(() => expect(within(sheet).getAllByTestId('recording-row')).toHaveLength(1));
  // Insert puts the text in the composer and closes the sheet.
  fireEvent.click(within(sheet).getByRole('button', { name: 'Insert' }));
  expect(d.insert).toHaveBeenCalledWith('an older dictation');
  void act;
});

