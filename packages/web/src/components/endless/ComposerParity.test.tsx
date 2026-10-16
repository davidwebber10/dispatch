import { StrictMode } from 'react';
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
const png = (read: () => Promise<ArrayBuffer> = async () => new Uint8Array([137, 80, 78, 71]).buffer) => {
  const f = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  Object.defineProperty(f, 'arrayBuffer', { value: read });
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
  it('does not stop the running turn when Send is tapped twice during a slow send', async () => {
    useEndless.setState({ turn: { status: 'running', error: null } });
    vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise(() => {}));
    const stopSpy = vi.spyOn(api, 'endlessStop').mockResolvedValue({ ok: true });
    render(<Composer />);
    fireEvent.change(box(), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.endlessSend).toHaveBeenCalledTimes(1));
    // The box is empty now, but the button stays a disabled Send until the send completes.
    const second = screen.getByRole('button', { name: 'Send' });
    expect(second).toBeDisabled();
    fireEvent.click(second);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(api.endlessSend).toHaveBeenCalledTimes(1);
  });

  it('does not restore the sent text twice when the send rejects before the next render (a fast reject)', async () => {
    vi.spyOn(api, 'endlessSend').mockRejectedValue(new Error('nope'));
    render(<Composer />);
    fireEvent.change(box(), { target: { value: 'raw' } });
    // The reject lands in a microtask, before React renders the cleared box: the catch must not see the old text.
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    expect(box().value).toBe('raw');
    expect(await screen.findByText(/nope/)).toBeInTheDocument();
  });

  it('keeps a disabled Send, not Stop, for a short while after a send resolves, so a quick second tap cannot stop the turn', async () => {
    vi.useFakeTimers();
    try {
      useEndless.setState({ turn: { status: 'running', error: null } });
      let done!: () => void;
      vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise((r) => { done = () => r({ ok: true }); }));
      const stopSpy = vi.spyOn(api, 'endlessStop').mockResolvedValue({ ok: true });
      render(<Composer />);
      fireEvent.change(box(), { target: { value: 'hello' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await act(async () => { done(); });
      // The send resolved between two quick taps: the button is still a Send.
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      expect(stopSpy).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves the text to the draft when a send fails after the user left Chat', async () => {
    let fail!: (e: Error) => void;
    vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise((_, rej) => { fail = rej; }));
    const first = render(<Composer />);
    fireEvent.change(box(), { target: { value: 'lost?' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(api.endlessSend).toHaveBeenCalled());
    first.unmount();
    expect(localStorage.getItem('dispatch:draft:chat')).toBeNull();
    await act(async () => { fail(new Error('late failure')); });
    expect(localStorage.getItem('dispatch:draft:chat')).toBe('lost?');
    render(<Composer />);
    expect(box().value).toBe('lost?');
  });

  it('tells the user that attached images were not saved when a send fails after the user left Chat', async () => {
    let fail!: (e: Error) => void;
    vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise((_, rej) => { fail = rej; }));
    const first = render(<Composer />);
    fireEvent.change(box(), { target: { value: 'with a picture' } });
    fireEvent.paste(box(), { clipboardData: { files: [png()], types: ['Files'] } });
    await screen.findByRole('button', { name: 'Remove image' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(api.endlessSend).toHaveBeenCalled());
    first.unmount();
    await act(async () => { fail(new Error('late failure')); });
    expect(localStorage.getItem('dispatch:draft:chat')).toBe('with a picture');
    render(<Composer />);
    expect(screen.getByRole('alert')).toHaveTextContent(/1 image .*not saved/i);
  });

  it('says so when a picked file is not an image the model can read, instead of dropping it silently', async () => {
    const { container } = render(<Composer />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const heic = new File([new Uint8Array([1, 2, 3])], 'IMG_0001.HEIC', { type: 'image/heic' });
    const blank = new File([new Uint8Array([1, 2, 3])], 'IMG_0002', { type: '' });
    fireEvent.change(input, { target: { files: [heic, blank, png()] } });
    expect(await screen.findByRole('button', { name: 'Remove image' })).toBeInTheDocument(); // the PNG still attaches
    expect(screen.getByRole('alert')).toHaveTextContent(/2 files? not attached.*image\/heic.*unknown/i);
  });

  it('says so when every picked file is skipped', async () => {
    const { container } = render(<Composer />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'a.heic', { type: 'image/heic' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/1 file not attached.*image\/heic/i);
    expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();
  });

  it('counts a failed read in the same notice', async () => {
    const { container } = render(<Composer />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [png(() => Promise.reject(new Error('read failed'))), png()] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not read the image: read failed/);
  });

  it('does not raise an unhandled rejection when reading a pasted image fails', async () => {
    const seen: unknown[] = [];
    const onRej = (e: unknown) => { seen.push(e); };
    process.on('unhandledRejection', onRej);
    try {
      render(<Composer />);
      fireEvent.paste(box(), { clipboardData: { files: [png(() => Promise.reject(new Error('read failed')))], types: ['Files'] } });
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([]);
      expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();
      expect(await screen.findByText(/Could not read the image: read failed/)).toBeInTheDocument();
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });

  it('adds the failed text after the draft of a later composer, and does not overwrite it, when a send fails after unmount', async () => {
    let fail!: (e: Error) => void;
    vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise((_, rej) => { fail = rej; }));
    const first = render(<Composer />);
    fireEvent.change(box(), { target: { value: 'old text' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(api.endlessSend).toHaveBeenCalled());
    first.unmount();
    render(<Composer />);
    fireEvent.change(box(), { target: { value: 'newer draft' } });
    await act(async () => { fail(new Error('late failure')); });
    expect(box().value).toBe('newer draft, old text');
    expect(localStorage.getItem('dispatch:draft:chat')).toBe('newer draft, old text');
  });

  it('does not swallow a text drop: it calls preventDefault only for a file drag', () => {
    const { container } = render(<Composer />);
    const zone = container.firstElementChild as HTMLElement;
    expect(fireEvent.drop(zone, { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true);
    expect(fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [] } })).toBe(false);
  });

  it('does not send before a pasted image has been read, so the image is not left for the next message', async () => {
    const send = vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    render(<Composer />);
    let release!: () => void;
    const f = png(() => new Promise<ArrayBuffer>((r) => { release = () => r(new Uint8Array([1, 2]).buffer); }));
    fireEvent.change(box(), { target: { value: 'look' } });
    fireEvent.paste(box(), { clipboardData: { files: [f], types: ['Files'] } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    expect(box().value).toBe('look');
    await act(async () => { release(); });
    await screen.findByRole('button', { name: 'Remove image' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('look', null, [expect.objectContaining({ media_type: 'image/png' })]));
  });

  it('recalculates the height when the window resizes', () => {
    render(<Composer />);
    const el = box();
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 60 });
    fireEvent.change(el, { target: { value: 'wrapped text' } });
    expect(el.style.height).toBe('60px');
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 34 });
    fireEvent(window, new Event('resize'));
    expect(el.style.height).toBe('34px');
  });

  // A send that fails after the composer unmounted: returns the rejecter, so the case can fail it later.
  const startSend = async (value: string, withImage: boolean) => {
    let fail!: (e: Error) => void;
    vi.spyOn(api, 'endlessSend').mockImplementationOnce(() => new Promise((_, rej) => { fail = rej; }));
    const view = render(<Composer />);
    if (value) fireEvent.change(box(), { target: { value } });
    if (withImage) {
      fireEvent.paste(box(), { clipboardData: { files: [png()], types: ['Files'] } });
      await screen.findByRole('button', { name: 'Remove image' });
    }
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(api.endlessSend).toHaveBeenCalled());
    return { view, fail: async (m: string) => { await act(async () => { fail(new Error(m)); }); } };
  };

  it('shows the lost-image notice when the composer is rendered twice, as React StrictMode does in dev', async () => {
    const s = await startSend('with a picture', true);
    s.view.unmount();
    await s.fail('late failure');
    render(<StrictMode><Composer /></StrictMode>);
    expect(screen.getByRole('alert')).toHaveTextContent(/1 image .*not saved/i);
  });

  it('shows the notice only once: a third mount does not show it again', async () => {
    const s = await startSend('with a picture', true);
    s.view.unmount();
    await s.fail('late failure');
    const second = render(<Composer />);
    expect(screen.getByRole('alert')).toHaveTextContent(/not saved/i);
    second.unmount();
    render(<Composer />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the notice at once in a composer that is already mounted', async () => {
    const s = await startSend('with a picture', true);
    s.view.unmount();
    const later = render(<Composer />);
    expect(screen.queryByRole('alert')).toBeNull();
    await s.fail('late failure');
    expect(screen.getByRole('alert')).toHaveTextContent(/1 image .*not saved/i);
    later.unmount();
    render(<Composer />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not say the text came back when the failed message had only images', async () => {
    const s = await startSend('', true);
    s.view.unmount();
    await s.fail('late failure');
    render(<Composer />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/1 image was not saved/i);
    expect(alert).not.toHaveTextContent(/text is back/i);
  });

  it('says the text came back when the failed message had text and images', async () => {
    const s = await startSend('words', true);
    s.view.unmount();
    await s.fail('late failure');
    render(<Composer />);
    expect(screen.getByRole('alert')).toHaveTextContent(/text is back in the draft/i);
  });

  it('adds 2 images and then 1 image to 3 when both sends fail before a composer shows the notice', async () => {
    const fails: Array<(e: Error) => void> = [];
    vi.spyOn(api, 'endlessSend').mockImplementation(() => new Promise((_, rej) => { fails.push(rej); }));
    const send = async (count: number) => {
      const view = render(<Composer />);
      for (let i = 0; i < count; i++) {
        fireEvent.paste(box(), { clipboardData: { files: [png()], types: ['Files'] } });
        await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove image' })).toHaveLength(i + 1));
      }
      fireEvent.keyDown(box(), { key: 'Enter' });
      await waitFor(() => expect(fails.length).toBeGreaterThan(0));
      view.unmount();
    };
    await send(2);
    const afterFirst = fails.length;
    await send(1);
    expect(fails.length).toBe(afterFirst + 1);
    await act(async () => { fails.forEach((f) => f(new Error('down'))); });
    render(<Composer />);
    expect(screen.getByRole('alert')).toHaveTextContent(/3 images were not saved/i);
  });

  it('keeps "hello" as it is when an image-only message fails after the user left Chat', async () => {
    const s = await startSend('', true);
    s.view.unmount();
    const later = render(<Composer />);
    fireEvent.change(box(), { target: { value: 'hello' } });
    later.unmount();
    await s.fail('late failure');
    expect(localStorage.getItem('dispatch:draft:chat')).toBe('hello');
    render(<Composer />);
    expect(box().value).toBe('hello');
  });
});
