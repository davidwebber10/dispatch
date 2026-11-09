// The "/" menu and the model/effort chip in Chat: one Chat-wide setting (rebuild of PR #155 on main 4.3.0).
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
const chip = () => screen.findByRole('button', { name: /^Model:/ });

describe('Chat', () => {
  it('shows the Chat model on the same chip as a thread, and changes it for all of Chat', async () => {
    render(<EndlessColumn />);
    fireEvent.click(await chip());
    expect(screen.getByRole('radio', { name: 'Opus' })).toHaveAttribute('aria-checked', 'true'); // the default is the model it runs
    fireEvent.click(screen.getByRole('radio', { name: 'Haiku' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ model: 'haiku' }));
    expect(await screen.findByRole('button', { name: /^Model: Haiku/ })).toBeInTheDocument();
  });

  it('the card also has the effort levels; a pick saves it for all of Chat', async () => {
    render(<EndlessColumn />);
    fireEvent.click(await chip());
    fireEvent.click(screen.getByRole('radio', { name: 'high' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith({ effort: 'high' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved for all of Chat. Applies from the next message.'));
  });

  it('/effort high saves the Chat effort and does not send a message', async () => {
    render(<EndlessColumn />);
    await chip();
    typeAndEnter('/effort high');
    await waitFor(() => expect(put).toHaveBeenCalledWith({ effort: 'high' }));
    expect(send).not.toHaveBeenCalled();
    expect(box().value).toBe('');
  });

  it('/model sonnet saves the Chat model', async () => {
    render(<EndlessColumn />);
    await chip();
    typeAndEnter('/model sonnet');
    await waitFor(() => expect(put).toHaveBeenCalledWith({ model: 'sonnet' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('a bare /model opens the chip\'s card', async () => {
    render(<EndlessColumn />);
    await chip();
    typeAndEnter('/model');
    expect(await screen.findByRole('radiogroup', { name: 'Model' })).toBeInTheDocument();
  });

  it('lists only /model, /effort and /stop', async () => {
    render(<EndlessColumn />);
    await chip();
    fireEvent.change(box(), { target: { value: '/' } });
    expect(screen.getAllByRole('option').map((o) => o.firstElementChild?.textContent)).toEqual(['/model', '/effort', '/stop']);
  });

  it('/compact is not a Chat command: it is refused, not sent', async () => {
    render(<EndlessColumn />);
    await chip();
    typeAndEnter('/compact');
    expect(screen.getByRole('alert')).toHaveTextContent('/compact is not available here.');
    expect(send).not.toHaveBeenCalled();
  });

  it('a normal message still sends', async () => {
    render(<EndlessColumn />);
    await chip();
    typeAndEnter('check the exporter');
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toBe('check the exporter');
  });

  it('a refused Chat change is a visible line above the box, and a bad typed value keeps the text', async () => {
    put.mockRejectedValueOnce(new Error('Chat is unavailable'));
    render(<EndlessColumn />);
    await chip();
    typeAndEnter('/model haiku');
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/Model change refused: Chat is unavailable/));
    expect(box().value).toBe('/model haiku');
  });
});
