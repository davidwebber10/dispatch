import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Composer } from './EndlessColumn';
import { useEndless } from '../../stores/endless';
import { useSettings } from '../../stores/settings';
import { useUI } from '../../stores/ui';

// The Chat composer is the shared PillComposer: + (Project, Add file) | text | mic | send.

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
  it('the + opens Add file, which opens the file picker', () => {
    render(<Composer />);
    expect(screen.queryByRole('button', { name: 'Attach a file' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(picker, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /Add file/ }));
    expect(click).toHaveBeenCalled();
  });

  it('a mic without dictation set up says so and links to Settings → Transcription', () => {
    useSettings.setState({ sttProvider: '', sttModel: '', sttSecretName: '' } as never);
    const requestSettings = vi.spyOn(useUI.getState(), 'requestSettings');
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
    expect(screen.getByRole('note')).toHaveTextContent("Dictation isn't set up yet.");
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(requestSettings).toHaveBeenCalledWith('transcription');
    expect(screen.queryByRole('note')).toBeNull();
    // Dictate is not in the + menu: the mic is its one place.
    fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
    expect(screen.queryAllByRole('button', { name: /Dictate/ })).toHaveLength(1);
  });
});
