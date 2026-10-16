import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Composer } from './EndlessColumn';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';

let saved: ReturnType<typeof useEndless.getState>;
beforeEach(() => {
  localStorage.clear(); // drafts persist in local storage; each case starts with none
  saved = useEndless.getState();
  useEndless.setState({ filter: null, projects: [], turn: { status: 'idle', error: null } });
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => { useEndless.setState(saved, true); });
});

// jsdom's File has no arrayBuffer(); give the fixture one, as a browser's File has.
const png = () => {
  const f = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  Object.defineProperty(f, 'arrayBuffer', { value: async () => new Uint8Array([137, 80, 78, 71]).buffer });
  return f;
};
const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;

describe('Chat composer parity with the other composers', () => {
  it('attaches an image pasted from the clipboard and does not paste text for it', async () => {
    render(<Composer />);
    const ev = fireEvent.paste(box(), { clipboardData: { files: [png()], types: ['Files'] } });
    expect(ev).toBe(false); // default prevented
    expect(await screen.findByRole('button', { name: 'Remove image' })).toBeInTheDocument();
  });

  it('leaves a plain text paste alone', () => {
    render(<Composer />);
    expect(fireEvent.paste(box(), { clipboardData: { files: [], types: ['text/plain'] } })).toBe(true);
    expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();
  });

  it('attaches an image dropped on the composer and shows a drop cue while dragging', async () => {
    const { container } = render(<Composer />);
    const zone = container.firstElementChild as HTMLElement;
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'], files: [] } });
    expect(screen.getByText('Drop image to attach')).toBeInTheDocument();
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [png()] } });
    expect(await screen.findByRole('button', { name: 'Remove image' })).toBeInTheDocument();
    expect(screen.queryByText('Drop image to attach')).toBeNull();
  });

  it('sends a pasted screenshot with no caption', async () => {
    const send = vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    render(<Composer />);
    fireEvent.paste(box(), { clipboardData: { files: [png()], types: ['Files'] } });
    await screen.findByRole('button', { name: 'Remove image' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('', null, [expect.objectContaining({ media_type: 'image/png' })]));
  });

  it('grows with the text up to 200px, then scrolls', () => {
    render(<Composer />);
    const el = box();
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 90 });
    fireEvent.change(el, { target: { value: 'a\nb\nc\nd' } });
    expect(el.style.height).toBe('90px');
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 500 });
    fireEvent.change(el, { target: { value: 'x'.repeat(50) } });
    expect(el.style.height).toBe('200px');
  });

  it('shrinks back after a send', async () => {
    vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    render(<Composer />);
    const el = box();
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 90 });
    fireEvent.change(el, { target: { value: 'hi' } });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 34 });
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(el.value).toBe(''));
    await waitFor(() => expect(el.style.height).toBe('34px'));
  });

  it('keeps an unsent draft across a remount (reload)', () => {
    const { unmount } = render(<Composer />);
    fireEvent.change(box(), { target: { value: 'half typed' } });
    unmount();
    render(<Composer />);
    expect(box().value).toBe('half typed');
  });

  it('does not send on Shift+Enter or mid-composition Enter', () => {
    const send = vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    render(<Composer />);
    fireEvent.change(box(), { target: { value: 'x' } });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send a sent part again when the user keeps typing while the send is in flight', async () => {
    const resolvers: Array<() => void> = [];
    const send = vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise((r) => { resolvers.push(() => r({ ok: true })); }));
    render(<Composer />);
    fireEvent.change(box(), { target: { value: 'This was on opening. The tutorial? All' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // The box is empty at once, so more typing starts a new message.
    expect(box().value).toBe('');
    fireEvent.change(box(), { target: { value: 'steps had the same issue' } });
    await act(async () => { resolvers[0](); });
    expect(box().value).toBe('steps had the same issue');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0]).toBe('steps had the same issue');
  });

  it('puts the text back in front of new typing when the send fails', async () => {
    let fail!: (e: Error) => void;
    vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise((_, rej) => { fail = rej; }));
    render(<Composer />);
    fireEvent.change(box(), { target: { value: 'first part' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(api.endlessSend).toHaveBeenCalled());
    fireEvent.change(box(), { target: { value: 'more' } });
    await act(async () => { fail(new Error('503 down')); });
    expect(box().value).toBe('first part more');
    expect(await screen.findByText(/503 down/)).toBeInTheDocument();
  });

  it('removes the stored draft at once, so a reload during a slow send does not bring it back', async () => {
    vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise(() => {}));
    render(<Composer />);
    fireEvent.change(box(), { target: { value: 'sent text' } });
    expect(localStorage.getItem('dispatch:draft:chat')).toBe('sent text');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(api.endlessSend).toHaveBeenCalled());
    expect(localStorage.getItem('dispatch:draft:chat')).toBeNull();
  });
});
