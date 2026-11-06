import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { PillComposer } from '../PillComposer';
import { useSlashMenu, runModelEffortCommand } from './useSlashMenu';
import type { SlashHarness, SlashSurface } from '../../../lib/slash';

const dictation = { state: 'idle', error: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), reset: vi.fn(), getAnalyser: () => null } as never;

let sent: string[];
let run: ReturnType<typeof vi.fn>;
beforeEach(() => { sent = []; run = vi.fn().mockResolvedValue(undefined); });

function Host({ harness = 'claude-code', surface = 'thread', mobile = false, model = null, effort = null }: { harness?: SlashHarness; surface?: SlashSurface; mobile?: boolean; model?: string | null; effort?: string | null }) {
  const [value, setValue] = useState('');
  const slash = useSlashMenu({ surface, harness, value, setValue, mobile, run, model, effort });
  return (
    <PillComposer
      value={value} onChange={setValue} canSend placeholder="Message…" onAddFile={() => {}} dictation={dictation} sttConfigured
      onSend={() => { if (slash.interceptSend()) return; sent.push(value); setValue(''); }}
      textareaProps={{ onKeyDown: slash.onKeyDown }} slash={slash.overlay} menuExtra={slash.plusRow} mobile={mobile}
    />
  );
}

const box = () => screen.getByPlaceholderText('Message…') as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });
const names = () => screen.queryAllByRole('option').map((o) => o.firstElementChild?.textContent ?? '');

describe('the "/" menu', () => {
  it('opens on a slash at the start, filters as you type, and closes when nothing matches', () => {
    render(<Host />);
    type('/');
    expect(names()).toEqual(['/model', '/effort', '/compact', '/stop', '/cli', '/restart']);
    type('/co');
    expect(names()).toHaveLength(1);
    expect(names()[0]).toMatch(/^\/compact/);
    type('/zzz');
    expect(names()).toHaveLength(0);
    type('hello /model');
    expect(names()).toHaveLength(0);
  });

  it('says how to send a message that starts with a slash', () => {
    render(<Host />);
    type('/');
    expect(screen.getByText(/put a space before it/i)).toBeInTheDocument();
  });

  it('arrow keys move, Enter runs the highlighted command, and the box is cleared', async () => {
    render(<Host />);
    type('/');
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true'); // compact
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(run).toHaveBeenCalledWith('compact', ''));
    expect(box().value).toBe('');
    expect(sent).toEqual([]); // never sent to the model
  });

  it('Enter on /model typed out in full opens the picker (empty arguments); it does not pick a model', async () => {
    render(<Host />);
    type('/model');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(run).toHaveBeenCalledWith('model', ''));
    expect(sent).toEqual([]);
  });

  it('Tab on /mo fills /model and lists the models; choosing one changes the model', async () => {
    render(<Host model="opus" />);
    type('/mo');
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(box().value).toBe('/model ');
    expect(names()).toEqual(['Default', 'Fable', 'Opus', 'Sonnet', 'Haiku']);
    expect(screen.getByText('current').closest('[role=option]')).toHaveTextContent(/Opus/);
    type('/model so');
    expect(names()).toHaveLength(1);
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(run).toHaveBeenCalledWith('model', 'sonnet'));
  });

  it('lists the effort levels for the harness', () => {
    const { unmount } = render(<Host />);
    type('/effort ');
    expect(names()).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    unmount();
    render(<Host harness="codex" effort="high" />);
    type('/effort ');
    expect(names()).toHaveLength(4);
  });

  it('a mouse click on a command runs it', async () => {
    render(<Host />);
    type('/st');
    fireEvent.click(screen.getByRole('option'));
    await waitFor(() => expect(run).toHaveBeenCalledWith('stop', ''));
  });

  it('Escape closes the list and leaves the text', () => {
    render(<Host />);
    type('/');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(names()).toHaveLength(0);
    expect(box().value).toBe('/');
  });

  it('greys a command the agent cannot run, with the reason, and does not run it', () => {
    render(<Host harness="grok" />);
    type('/mod');
    const opt = screen.getByRole('option');
    expect(opt).toHaveAttribute('aria-disabled', 'true');
    expect(opt).toHaveTextContent(/not yet available/i);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(run).not.toHaveBeenCalled();
  });

  it('shows the short Chat list', () => {
    render(<Host surface="chat" />);
    type('/');
    expect(names()).toEqual(['/model', '/effort', '/stop']);
  });
});

describe('sending text that starts with a slash', () => {
  const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  it('a known command is run, never sent to the model', async () => {
    render(<Host />);
    type('/compact');
    send();
    await waitFor(() => expect(run).toHaveBeenCalledWith('compact', ''));
    expect(sent).toEqual([]);
  });

  it('/effort high runs with its argument', async () => {
    render(<Host />);
    type('/effort high');
    send();
    await waitFor(() => expect(run).toHaveBeenCalledWith('effort', 'high'));
    expect(sent).toEqual([]);
  });

  it('a command with extra words that it does not take is refused with a plain note', () => {
    render(<Host />);
    type('/compact now please');
    send();
    expect(run).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(screen.getByRole('alert')).toHaveTextContent('/compact takes no extra words.');
  });

  it('a command this surface does not have is refused, not sent', () => {
    render(<Host surface="chat" />);
    type('/cli');
    send();
    expect(sent).toEqual([]);
    expect(screen.getByRole('alert')).toHaveTextContent('/cli is not available here.');
  });

  it('a greyed command is refused with its reason', () => {
    render(<Host harness="grok" />);
    type('/effort high');
    send();
    expect(sent).toEqual([]);
    expect(screen.getByRole('alert')).toHaveTextContent(/not yet available/i);
  });

  it('an unknown /word goes to Claude as text', () => {
    render(<Host />);
    type('/frobnicate now');
    send();
    expect(sent).toEqual(['/frobnicate now']);
  });

  it('an unknown /word in Codex shows a hint first; a second Enter sends it', () => {
    render(<Host harness="codex" />);
    type('/frobnicate');
    send();
    expect(sent).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent(/Codex has no \/frobnicate command/);
    send();
    expect(sent).toEqual(['/frobnicate']);
  });

  it('a leading space is the escape: the text goes as it is, even for a known command word', () => {
    render(<Host />);
    type(' /model opus');
    send();
    expect(run).not.toHaveBeenCalled();
    expect(sent).toEqual([' /model opus']);
  });

  it('a path is plain text', () => {
    render(<Host />);
    type('/usr/local/bin is on my path');
    send();
    expect(sent).toEqual(['/usr/local/bin is on my path']);
  });

  it('a failing command shows its message and the text is gone from the box', async () => {
    run.mockRejectedValueOnce(new Error('No live structured session to compact'));
    render(<Host />);
    type('/compact');
    send();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No live structured session to compact'));
    expect(box().value).toBe('');
  });

  it('a note from a command is shown', async () => {
    run.mockResolvedValueOnce('Changed. Applies from the next turn.');
    render(<Host />);
    type('/effort high');
    send();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Changed. Applies from the next turn.'));
  });
});

describe('the phone Commands row', () => {
  it('is in the + menu on a phone only, and opens the same list as a sheet', async () => {
    const { unmount } = render(<Host mobile />);
    fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
    fireEvent.click(await screen.findByRole('button', { name: /Commands/ }));
    const sheet = await screen.findByRole('listbox', { name: 'Commands' });
    expect(within(sheet).getAllByRole('option')).toHaveLength(6);
    fireEvent.click(within(sheet).getByText('/model'));
    await waitFor(() => expect(run).toHaveBeenCalledWith('model', ''));
    unmount();
    render(<Host mobile={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
    expect(screen.queryByRole('button', { name: /Commands/ })).toBeNull();
  });
});

describe('runModelEffortCommand', () => {
  const o = (args: string, name: 'model' | 'effort' = 'model', harness: SlashHarness = 'claude-code') => {
    const openPicker = vi.fn(); const apply = vi.fn().mockResolvedValue('ok');
    return { p: runModelEffortCommand({ harness, name, args, openPicker, apply }), openPicker, apply };
  };
  it('opens the picker without an argument', async () => {
    const r = o(''); await r.p;
    expect(r.openPicker).toHaveBeenCalled(); expect(r.apply).not.toHaveBeenCalled();
  });
  it('maps a model name, and default to null', async () => {
    const a = o('Opus'); await a.p; expect(a.apply).toHaveBeenCalledWith({ model: 'opus' });
    const b = o('default'); await b.p; expect(b.apply).toHaveBeenCalledWith({ model: null });
    const c = o('6 astra', 'model', 'codex'); await c.p; expect(c.apply).toHaveBeenCalledWith({ model: 'gpt-6-astra' });
  });
  it('maps an effort and throws a plain error for a bad value', async () => {
    const a = o('HIGH', 'effort'); await a.p; expect(a.apply).toHaveBeenCalledWith({ effort: 'high' });
    await expect(o('turbo', 'effort').p).rejects.toThrow(/low, medium, high, xhigh, max/);
    await expect(o('banana').p).rejects.toThrow(/Unknown model/);
  });
});
