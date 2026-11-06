import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Composer } from './EndlessColumn';
import { useEndless } from '../../stores/endless';
import { useSettings } from '../../stores/settings';

// The Chat composer's left control is a + that opens up to Add file / Dictate, like the
// thread composers (it used to be a bare paperclip).

let saved: ReturnType<typeof useEndless.getState>;
beforeEach(() => {
  localStorage.clear();
  saved = useEndless.getState();
  useEndless.setState({ filter: null, projects: [], turn: { status: 'idle', error: null } });
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => { useEndless.setState(saved, true); });
});

describe('Chat composer: + menu', () => {
  it('opens to Add file and Dictate; Add file opens the file picker', () => {
    render(<Composer />);
    expect(screen.queryByRole('button', { name: 'Attach a file' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(picker, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /Add file/ }));
    expect(click).toHaveBeenCalled();
  });

  it('Dictate is off, with a pointer to Settings, until transcription is set up', () => {
    useSettings.setState({ sttProvider: '', sttModel: '', sttSecretName: '' } as never);
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
    expect(screen.getByRole('button', { name: /Dictate/ })).toBeDisabled();
    expect(screen.getByText('Set up in Settings → Transcription')).toBeInTheDocument();
  });
});
