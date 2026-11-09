import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PillComposer } from './PillComposer';
import { usePluginRegistry } from '../../plugins/registry';
import { useSettings } from '../../stores/settings';

const dictation = (over: Record<string, unknown> = {}) => ({
  state: 'idle', error: null, progress: {}, recordingId: null, start: vi.fn(), retry: vi.fn(), insert: vi.fn(), stop: vi.fn(), cancel: vi.fn(), reset: vi.fn(), getAnalyser: () => null, ...over,
}) as never;

const base = { value: '', onChange: vi.fn(), onSend: vi.fn(), canSend: false, placeholder: 'Message…', onAddFile: vi.fn(), sttConfigured: true };

describe('PillComposer', () => {
  it('the line height follows the text scale, and is unchanged at 100%', () => {
    useSettings.setState({ textScale: 1 });
    const { unmount } = render(<PillComposer {...base} dictation={dictation()} />);
    expect(screen.getByPlaceholderText('Message…').style.lineHeight).toBe('21px');
    unmount();
    useSettings.setState({ textScale: 1.5 });
    render(<PillComposer {...base} dictation={dictation()} />);
    expect(screen.getByPlaceholderText('Message…').style.lineHeight).toBe('32px');
    useSettings.setState({ textScale: 1 });
  });

  it('a dictation error is a line above the box, and the text box stays usable', () => {
    const d = dictation({ state: 'error', error: 'Microphone access is blocked. Allow it in Settings → Dispatch → Microphone, then retry.' });
    render(<PillComposer {...base} dictation={d} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Microphone access is blocked');
    expect(screen.getByTestId('pill-composer')).not.toContainElement(alert);
    expect(screen.getByPlaceholderText('Message…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((d as { retry: ReturnType<typeof vi.fn> }).retry).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Recordings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect((d as { reset: ReturnType<typeof vi.fn> }).reset).toHaveBeenCalled();
  });

  it('a failed transcription with a kept recording: Retry sends the same recording, Recordings opens the sheet', async () => {
    const d = dictation({ state: 'error', error: 'Network error: the upload did not reach Dispatch. The recording is kept.', recordingId: 'r1' });
    render(<PillComposer {...base} dictation={d} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((d as { retry: ReturnType<typeof vi.fn> }).retry).toHaveBeenCalled();
    expect((d as { start: ReturnType<typeof vi.fn> }).start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Recordings' }));
    expect(await screen.findByRole('dialog', { name: 'Recordings' })).toBeInTheDocument();
  });

  it('the send key is the theme accent once there is something to send', () => {
    render(<PillComposer {...base} value="hi" canSend dictation={dictation()} />);
    expect(screen.getByRole('button', { name: 'Send' }).style.background).toBe('var(--color-accent)');
  });

  it('once there is text it gets its own full-width line above the + / mic / send row', () => {
    const { rerender } = render(<PillComposer {...base} dictation={dictation()} />);
    const box = screen.getByTestId('pill-composer');
    expect(box.getAttribute('data-stacked')).toBeNull();
    expect(box.style.gridTemplateAreas).toBe('"plus text mic send"');
    const ta = screen.getByPlaceholderText('Message…');
    rerender(<PillComposer {...base} value="hello" canSend dictation={dictation()} />);
    expect(box.getAttribute('data-stacked')).toBe('true');
    expect(box.style.gridTemplateAreas).toBe('"text text text text" "plus . mic send"');
    expect(screen.getByPlaceholderText('Message…')).toBe(ta); // the same box: typing keeps its focus
  });

  it('dictation stays on one row, even with text already typed: + · recording bar · send', () => {
    for (const value of ['', 'already typed']) {
      const { unmount } = render(<PillComposer {...base} value={value} dictation={dictation({ state: 'recording' })} />);
      const box = screen.getByTestId('pill-composer');
      expect(box.getAttribute('data-stacked')).toBeNull();
      expect(box.style.gridTemplateAreas).toBe('"plus text text send"');
      unmount();
    }
  });

  it('maxLines caps the box at that many lines, and onTallChange says when the text is taller (2026-11-07)', () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const onTall = vi.fn();
    const { rerender } = render(<PillComposer {...base} dictation={dictation()} mobile value="" onTallChange={onTall} />);
    const box = screen.getByPlaceholderText('Message…') as HTMLTextAreaElement;
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 300 });
    rerender(<PillComposer {...base} dictation={dictation()} mobile value={'line\n'.repeat(12)} onTallChange={onTall} />);
    expect(box.style.height).toBe('300px');
    expect(onTall).toHaveBeenLastCalledWith(true);
    rerender(<PillComposer {...base} dictation={dictation()} mobile value={'line\n'.repeat(12)} maxLines={2} onTallChange={onTall} />);
    expect(box.style.height).toBe('64px'); // two 22 px lines inside the 42 px key height
    expect(onTall).toHaveBeenLastCalledWith(true); // still taller than two lines: the handle stays
  });

  describe('going to two lines glides instead of jumping (2026-11-06)', () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = realRect;
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    });
    // jsdom lays nothing out: give the box and the text box different places in the two layouts.
    const fakeLayout = () => {
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const box = this.closest('[data-testid="pill-composer"]') as HTMLElement | null;
        const two = !!box?.hasAttribute('data-stacked');
        if (this === box) return { left: 0, top: two ? 600 : 640, width: 360, height: two ? 88 : 48 } as DOMRect;
        if (this.tagName === 'TEXTAREA') return { left: two ? 6 : 46, top: two ? 606 : 646, width: two ? 348 : 230, height: 36 } as DOMRect;
        return { left: 0, top: 0, width: 36, height: 36 } as DOMRect;
      };
    };

    it('the text box slides from its old place and the box grows, once, when the layout switches', () => {
      fakeLayout();
      const animate = vi.fn();
      (HTMLElement.prototype as { animate?: unknown }).animate = animate;
      const { rerender } = render(<PillComposer {...base} dictation={dictation()} />);
      expect(animate).not.toHaveBeenCalled();
      rerender(<PillComposer {...base} value="h" canSend dictation={dictation()} />);
      const frames = animate.mock.calls.map((c) => c[0][0]);
      expect(frames).toContainEqual({ transform: 'translate(40px, 40px)' }); // the text box, from the one-row spot
      expect(frames).toContainEqual({ height: '48px' }); // the box, from one row's height
      animate.mockClear();
      rerender(<PillComposer {...base} value="he" canSend dictation={dictation()} />); // typing on: no new layout, no animation
      expect(animate).not.toHaveBeenCalled();
    });
  });
});


describe('plugin composer actions (2026-11-07)', () => {
  afterEach(() => { usePluginRegistry.setState({ composerActions: [] }); });

  it('actions render as a row above the pill; insert appends with a space, set replaces; the context names the surface', () => {
    const seen: unknown[] = [];
    usePluginRegistry.getState().register('fav', { composerActions: [
      { id: 'a', label: 'Summarise', onClick: (ctx) => { seen.push({ surface: ctx.surface, terminalId: ctx.terminalId }); ctx.insert('Summarise where you are.'); } },
      { id: 'b', label: 'Replace', onClick: (ctx) => ctx.set('fresh text') },
    ] });
    const onChange = vi.fn();
    render(<PillComposer {...base} value="hello" onChange={onChange} dictation={dictation()} pluginContext={{ surface: 'thread', terminalId: 't1' }} />);
    const row = screen.getByTestId('composer-plugin-actions');
    expect(row.compareDocumentPosition(screen.getByTestId('pill-composer')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Summarise' }));
    expect(onChange).toHaveBeenCalledWith('hello Summarise where you are.');
    expect(seen).toEqual([{ surface: 'thread', terminalId: 't1' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(onChange).toHaveBeenCalledWith('fresh text');
  });

  it('a composer.before slot renders above the actions row with the composer context', () => {
    usePluginRegistry.getState().register('tpl', {
      slots: [{ id: 'form', slot: 'composer.before', Component: ({ surface, value }: Record<string, unknown>) => <div data-testid="tpl">template for {String(surface)}: {String(value)}</div> }],
      composerActions: [{ id: 'a', label: 'Go', onClick: () => {} }],
    });
    render(<PillComposer {...base} value="draft" dictation={dictation()} pluginContext={{ surface: 'chat' }} />);
    const slot = screen.getByTestId('tpl');
    expect(slot).toHaveTextContent('template for chat: draft');
    expect(slot.compareDocumentPosition(screen.getByTestId('composer-plugin-actions')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    usePluginRegistry.getState().unregister('tpl');
  });

  it('insert into an empty composer adds no leading space; `when` hides an action; the row is absent with no actions', () => {
    const onChange = vi.fn();
    usePluginRegistry.getState().register('fav', { composerActions: [
      { id: 'a', label: 'Go', onClick: (ctx) => ctx.insert('Run the tests.') },
      { id: 'chat-only', label: 'Chat only', when: (ctx) => ctx.surface === 'chat', onClick: () => {} },
    ] });
    render(<PillComposer {...base} value="" onChange={onChange} dictation={dictation()} pluginContext={{ surface: 'thread' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onChange).toHaveBeenCalledWith('Run the tests.');
    expect(screen.queryByRole('button', { name: 'Chat only' })).toBeNull();
    usePluginRegistry.setState({ composerActions: [] });
    const { queryByTestId } = render(<PillComposer {...base} dictation={dictation()} />);
    expect(queryByTestId('composer-plugin-actions')).toBeNull();
  });

  describe('the phone expands a long message to a full-screen editor (2026-11-07)', () => {
    const grow = (h: number) => Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get() { return h; } });
    afterEach(() => { delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight; });
    it('the expand button appears at three lines on a phone only', () => {
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
      grow(42);
      const { rerender } = render(<PillComposer {...base} dictation={dictation()} mobile value="one line" />);
      expect(screen.queryByRole('button', { name: 'Expand the message' })).toBeNull();
      grow(90); // three lines
      rerender(<PillComposer {...base} dictation={dictation()} mobile value={'a\nb\nc'} />);
      expect(screen.getByRole('button', { name: 'Expand the message' })).toBeInTheDocument();
      rerender(<PillComposer {...base} dictation={dictation()} value={'a\nb\nc'} />);
      expect(screen.queryByRole('button', { name: 'Expand the message' })).toBeNull(); // desktop: never
    });
    it('the editor shows the same text without raising the keyboard; typing, collapse and send work', () => {
      Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
      grow(90);
      const onChange = vi.fn(); const onSend = vi.fn();
      render(<PillComposer {...base} dictation={dictation()} mobile value={'a\nb\nc'} canSend onChange={onChange} onSend={onSend} />);
      fireEvent.click(screen.getByRole('button', { name: 'Expand the message' }));
      const editor = screen.getByRole('dialog', { name: 'Message' });
      const area = editor.querySelector('textarea') as HTMLTextAreaElement;
      expect(area.value).toBe('a\nb\nc');
      expect(document.activeElement).not.toBe(area); // scroll first; a tap in the text types
      fireEvent.change(area, { target: { value: 'a\nb\nc\nd' } });
      expect(onChange).toHaveBeenLastCalledWith('a\nb\nc\nd');
      fireEvent.click(screen.getByRole('button', { name: 'Collapse the message' }));
      expect(screen.queryByRole('dialog', { name: 'Message' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Expand the message' }));
      fireEvent.click(screen.getAllByRole('button', { name: 'Send' }).at(-1)!);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog', { name: 'Message' })).toBeNull();
    });
  });
});
