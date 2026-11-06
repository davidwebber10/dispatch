// The "/" menu and the model/effort picker in Chat (slash menu, 2026-11-06): one Chat-wide setting.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EndlessColumn } from './EndlessColumn';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

let put: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  send = vi.fn().mockResolvedValue(undefined);
  useEndless.setState({
    messages: [], loaded: true, hasMore: false, atTail: true, focus: null, filter: null, liveText: '', liveThinking: '',
    turn: { status: 'idle', error: null }, projects: [], pending: [], send, stop: vi.fn().mockResolvedValue(undefined),
  } as never);
  vi.spyOn(api, 'endlessSettings').mockResolvedValue({ model: null, effort: null, defaultModel: 'opus' });
  put = vi.fn(async (c: { model?: string | null; effort?: string | null }) => ({ model: c.model === undefined ? null : c.model, effort: c.effort ?? null, defaultModel: 'opus' }));
  vi.spyOn(api, 'setEndlessSettings').mockImplementation(put as never);
});

const box = () => screen.getByPlaceholderText('Message Dispatch…') as HTMLTextAreaElement;
const typeAndEnter = (text: string) => { fireEvent.change(box(), { target: { value: text } }); fireEvent.keyDown(box(), { key: 'Enter' }); };

describe('Chat', () => {
  it('shows the Chat model under the composer and changes it for all of Chat from the picker', async () => {
    render(<EndlessColumn />);
    fireEvent.click(await screen.findByRole('button', { name: 'Opus' }));
    expect(screen.getByRole('button', { name: 'Default (Opus)', pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Haiku' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ model: 'haiku' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved for all of Chat. Applies from the next turn.'));
    expect(screen.getByRole('button', { name: 'Haiku', expanded: true })).toBeInTheDocument(); // the trigger now reads the new model
  });

  it('/effort high saves the Chat effort and does not send a message', async () => {
    render(<EndlessColumn />);
    await screen.findByRole('button', { name: 'Opus' });
    typeAndEnter('/effort high');
    await waitFor(() => expect(put).toHaveBeenCalledWith({ effort: 'high' }));
    expect(send).not.toHaveBeenCalled();
    expect(box().value).toBe('');
  });

  it('lists only /model, /effort and /stop', async () => {
    render(<EndlessColumn />);
    await screen.findByRole('button', { name: 'Opus' });
    fireEvent.change(box(), { target: { value: '/' } });
    expect(screen.getAllByRole('option').map((o) => o.firstElementChild?.textContent)).toEqual(['/model', '/effort', '/stop']);
  });

  it('/compact is not a Chat command: it is refused, not sent', async () => {
    render(<EndlessColumn />);
    await screen.findByRole('button', { name: 'Opus' });
    typeAndEnter('/compact');
    expect(screen.getByRole('alert')).toHaveTextContent('/compact is not available here.');
    expect(send).not.toHaveBeenCalled();
  });

  it('a normal message still sends', async () => {
    render(<EndlessColumn />);
    await screen.findByRole('button', { name: 'Opus' });
    typeAndEnter('check the exporter');
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toBe('check the exporter');
  });
});
