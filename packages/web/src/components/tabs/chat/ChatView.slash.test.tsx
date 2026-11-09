// The "/" menu and the effort picker in a Pretty thread, on top of the 4.2.0 model chip. Rebuild of PR #155.
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ChatView } from './ChatView';
import { api } from '../../../api/client';
import * as sock from '../../../api/structured-socket';
import { useTabs } from '../../../stores/tabs';
import { useActiveModel } from '../../../stores/activeModel';
import { useThreadStatus } from '../../../stores/threadStatus';
import { resetCodexInfoCache } from './modelControls';
import type { Terminal } from '../../../api/types';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

function thread(type: Terminal['type'], config: Record<string, unknown> = {}): Terminal {
  return { id: 't1', sessionId: 's1', type, label: 'T', pid: 1, externalId: 'e', workingDir: '/w', status: 'waiting', createdAt: '', config: { transport: 'structured', ...config }, archivedAt: null, sortOrder: 0 };
}

let send: ReturnType<typeof vi.fn>;
let setModel: ReturnType<typeof vi.fn>;
let setEffort: ReturnType<typeof vi.fn>;
let onEvent: ((e: any) => void) | undefined;
beforeEach(() => {
  vi.restoreAllMocks();
  onEvent = undefined;
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation((h: any) => { onEvent = h.onEvent; return { close: () => {} } as any; });
  send = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(api, 'sendStructuredMessage').mockImplementation(send as never);
  setModel = vi.fn().mockResolvedValue({ model: 'claude-opus-5-5', terminal: thread('claude-code') });
  vi.spyOn(api, 'setThreadModel').mockImplementation(setModel as never);
  setEffort = vi.fn().mockResolvedValue({ effort: 'high', terminal: thread('claude-code') });
  vi.spyOn(api, 'setThreadEffort').mockImplementation(setEffort as never);
  vi.spyOn(api, 'getResumeAdvice').mockResolvedValue({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
  useTabs.setState({ byProject: { s1: [thread('claude-code', { model: 'sonnet' })] } } as never);
  useActiveModel.setState({ byTerminal: {} });
  useThreadStatus.setState({ byTerminal: {} });
  resetCodexInfoCache();
});

const box = () => screen.findByPlaceholderText('Message…') as Promise<HTMLTextAreaElement>;
const typeAndEnter = async (text: string) => {
  if (!screen.queryByPlaceholderText('Message…')) render(<ChatView terminalId="t1" />);
  const ta = await box();
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.keyDown(ta, { key: 'Enter' });
};

describe('the "/" menu in a Pretty thread', () => {
  it('/effort high changes the effort through the chip\'s own call and sends nothing to the model', async () => {
    await typeAndEnter('/effort high');
    await waitFor(() => expect(setEffort).toHaveBeenCalledWith('t1', 'high'));
    expect(send).not.toHaveBeenCalled();
    expect((await box()).value).toBe('');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Effort changed. Applies from the next message.'));
  });

  it('/model opus switches the model through the chip\'s own call (POST /model), not a second path', async () => {
    await typeAndEnter('/model opus');
    await waitFor(() => expect(setModel).toHaveBeenCalledWith('t1', 'opus'));
    expect(send).not.toHaveBeenCalled();
    await waitFor(() => expect(useActiveModel.getState().byTerminal.t1).toBe('claude-opus-5-5'));
  });

  it('a bad value keeps the typed text and says why; nothing is sent (round 1 item 7)', async () => {
    await typeAndEnter('/model banana');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Unknown model "banana"/));
    expect((await box()).value).toBe('/model banana');
    expect(setModel).not.toHaveBeenCalled();
    await typeAndEnter('/effort turbo');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Unknown effort "turbo"/));
    expect((await box()).value).toBe('/effort turbo');
  });

  it('a change the daemon refuses keeps the text too', async () => {
    setModel.mockRejectedValueOnce(new Error("Model 'x' not found"));
    await typeAndEnter('/model haiku');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Model 'x' not found"));
    expect((await box()).value).toBe('/model haiku');
  });

  it('while a turn runs the chip is off, a bare /model says so, and a typed one gets the daemon\'s "busy" and keeps the text', async () => {
    render(<ChatView terminalId="t1" />);
    await typeAndEnter('hello');                       // a turn starts: the thread is busy
    await waitFor(() => expect(screen.getByRole('button', { name: /^Model:/ })).toBeDisabled());
    await typeAndEnter('/model');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/busy — change the model when the turn ends/));
    expect(screen.queryByRole('dialog')).toBeNull();
    setModel.mockRejectedValueOnce(new Error('This thread is busy — switch the model when the turn ends'));
    await typeAndEnter('/model opus');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/busy/));
    expect((await box()).value).toBe('/model opus');
  });

  it('/compact and /stop use the thread routes', async () => {
    const compact = vi.spyOn(api, 'compactTerminal').mockResolvedValue(undefined as never);
    const stop = vi.spyOn(api, 'interrupt').mockResolvedValue(undefined as never);
    await typeAndEnter('/compact');
    await waitFor(() => expect(compact).toHaveBeenCalledWith('t1'));
    await typeAndEnter('/stop');
    await waitFor(() => expect(stop).toHaveBeenCalledWith('t1'));
    expect(send).not.toHaveBeenCalled();
  });

  it('/restart restarts the thread once confirmed', async () => {
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue(thread('claude-code'));
    await typeAndEnter('/restart');
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledWith('t1'));
  });

  it('plain text still sends, an unknown /word goes to the harness as text (PS-3), and a leading space escapes a command', async () => {
    await typeAndEnter('hello');
    expect(send).toHaveBeenLastCalledWith('t1', 'hello');
    await typeAndEnter('/frobnicate now');
    expect(send).toHaveBeenLastCalledWith('t1', '/frobnicate now');
    await typeAndEnter(' /model opus');
    expect(send).toHaveBeenLastCalledWith('t1', ' /model opus');
    expect(setModel).not.toHaveBeenCalled();
  });

  it('typing / lists the commands above the box', async () => {
    render(<ChatView terminalId="t1" />);
    fireEvent.change(await box(), { target: { value: '/' } });
    expect(screen.getAllByRole('option').map((o) => o.firstElementChild?.textContent)).toEqual(['/model', '/effort', '/compact', '/stop', '/cli', '/restart']);
  });

  it('/model with no value opens the chip\'s card (one control, not a second picker)', async () => {
    await typeAndEnter('/model');
    expect(await screen.findByRole('radiogroup', { name: 'Model' })).toBeInTheDocument();
    expect(screen.getAllByRole('radiogroup', { name: 'Model' })).toHaveLength(1);
    expect(setModel).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('/restart always asks first', () => {
  it('idle: it asks, restarts only on "Restart", and Cancel leaves the thread alone', async () => {
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue(thread('claude-code'));
    await typeAndEnter('/restart');
    expect(await screen.findByRole('alertdialog', { name: /^Restart this thread\?/ })).toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(relaunch).not.toHaveBeenCalled();
    await typeAndEnter('/restart');
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledWith('t1'));
  });

  it('a Codex thread asks too', async () => {
    useTabs.setState({ byProject: { s1: [thread('codex')] } } as never);
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue(thread('codex'));
    await typeAndEnter('/restart');
    expect(await screen.findByRole('alertdialog', { name: /^Restart this thread\?/ })).toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('a turn that starts while the question is open changes it to the working warning', async () => {
    vi.spyOn(api, 'relaunchTerminal').mockResolvedValue(thread('claude-code'));
    await typeAndEnter('/restart');
    await screen.findByRole('alertdialog', { name: /^Restart this thread\?/ });
    act(() => { useTabs.setState({ byProject: { s1: [{ ...thread('claude-code', { model: 'sonnet' }), status: 'needs_input' }] } } as never); });
    expect(await screen.findByRole('alertdialog', { name: /Restart this thread now\?/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop and restart' })).toBeInTheDocument();
  });

  it('working: it asks, restarts only on "Stop and restart", and Cancel leaves the thread alone', async () => {
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue(thread('claude-code'));
    render(<ChatView terminalId="t1" />);
    await typeAndEnter('hello');                       // a turn starts: the thread is busy
    await typeAndEnter('/restart');
    expect(await screen.findByRole('alertdialog', { name: /Restart this thread now\?/ })).toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(relaunch).not.toHaveBeenCalled();
    await typeAndEnter('/restart');
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and restart' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledWith('t1'));
  });

  it('a thread parked on a question asks too', async () => {
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code', { model: 'sonnet' }), status: 'needs_input' }] } } as never);
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue(thread('claude-code'));
    await typeAndEnter('/restart');
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('the phone\'s Commands sheet confirms it too', async () => {
    const mobile = await import('../../../hooks/useIsMobile');
    vi.spyOn(mobile, 'useIsMobile').mockReturnValue(true);
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue(thread('claude-code'));
    render(<ChatView terminalId="t1" />);
    await typeAndEnter('hello');
    fireEvent.click(screen.getByRole('button', { name: 'More input options' }));
    fireEvent.click(await screen.findByRole('button', { name: /Commands/ }));
    const sheet = await screen.findByRole('listbox', { name: 'Commands' });
    fireEvent.click(within(sheet).getByText('/restart'));
    expect(await screen.findByRole('alertdialog', { name: /Restart this thread now\?/ })).toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('a restart that fails says why', async () => {
    vi.spyOn(api, 'relaunchTerminal').mockRejectedValue(new Error('Could not start'));
    render(<ChatView terminalId="t1" />);
    await typeAndEnter('hello');
    await typeAndEnter('/restart');
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and restart' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not restart: Could not start'));
  });
});

describe('a turn parked on a question disables the chip like a running turn (round 4, decision 1)', () => {
  it('the chip is off, and a bare /model says busy', async () => {
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code', { model: 'sonnet' }), status: 'needs_input' }] } } as never);
    render(<ChatView terminalId="t1" />);
    expect(await screen.findByRole('button', { name: /^Model:/ })).toBeDisabled();
    await typeAndEnter('/model');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/busy — change the model when the turn ends/));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the effort section of the chip card', () => {
  it('lists the Claude levels, marks the saved one, and a pick calls the effort route', async () => {
    useTabs.setState({ byProject: { s1: [thread('claude-code', { model: 'sonnet', effort: 'low' })] } } as never);
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    expect(screen.getAllByRole('radio', { name: /^(low|medium|high|xhigh|max)$/ }).map((r) => r.getAttribute('aria-label'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(screen.getByRole('radio', { name: 'low' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'max' }));
    await waitFor(() => expect(setEffort).toHaveBeenCalledWith('t1', 'max'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Effort changed'));
    expect(screen.getByRole('radiogroup', { name: 'Model' })).toBeInTheDocument(); // the card stays open for the next change
  });

  it('the chip names the saved effort', async () => {
    useTabs.setState({ byProject: { s1: [thread('claude-code', { model: 'sonnet', effort: 'high' })] } } as never);
    render(<ChatView terminalId="t1" />);
    expect(await screen.findByRole('button', { name: /Model: Sonnet, effort high/ })).toHaveTextContent('Sonnet · high');
  });

  it('a refusal shows the daemon\'s reason in the card', async () => {
    setEffort.mockRejectedValueOnce(new Error('effort refused'));
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'high' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('effort refused');
  });

  it('Grok and OpenCode have no effort section, and /effort is greyed with a reason; /model works', async () => {
    useTabs.setState({ byProject: { s1: [thread('grok', { model: 'grok-4.5' })] } } as never);
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    expect(screen.queryByRole('radiogroup', { name: 'Effort' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await typeAndEnter('/effort high');
    expect(screen.getByRole('alert')).toHaveTextContent(/not yet available/i);
    expect(setEffort).not.toHaveBeenCalled();
    await typeAndEnter('/model grok-4.5');
    await waitFor(() => expect(setModel).toHaveBeenCalled());
  });
});

describe('Codex efforts follow the model', () => {
  const luna = ['low', 'medium', 'high', 'xhigh', 'max'];
  const astra = [...luna, 'ultra'];
  beforeEach(() => {
    vi.spyOn(api, 'codexModelEfforts').mockResolvedValue({
      live: { 'gpt-6-luna': luna, 'gpt-6-astra': astra },
      defaults: { 'gpt-6-luna': 'low', 'gpt-6-astra': 'medium' },
    });
  });

  it('the card offers ultra for Astra and not for Luna', async () => {
    useActiveModel.setState({ byTerminal: { t1: 'gpt-6-astra' } });
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-astra' })] } } as never);
    const { unmount } = render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'ultra' })).toBeInTheDocument());
    unmount();
    resetCodexInfoCache();
    useActiveModel.setState({ byTerminal: { t1: 'gpt-6-luna' } });
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-luna' })] } } as never);
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    expect(await screen.findByRole('radio', { name: 'max' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'ultra' })).toBeNull();
  });

  it('marks the model\'s default as the current effort when none is saved (round 3 item 5)', async () => {
    useActiveModel.setState({ byTerminal: { t1: 'gpt-6-luna' } });
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-luna' })] } } as never);
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'low' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('radio', { name: 'low' })).toHaveTextContent('model default');
  });

  it('/effort lists the current model\'s own efforts', async () => {
    useActiveModel.setState({ byTerminal: { t1: 'gpt-6-luna' } });
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-luna' })] } } as never);
    render(<ChatView terminalId="t1" />);
    const ta = await box();
    await waitFor(() => expect(api.codexModelEfforts).toHaveBeenCalled());
    fireEvent.change(ta, { target: { value: '/effort ' } });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.firstElementChild?.textContent)).toEqual(luna));
  });

  it('an effort Luna does not take is refused before it is sent', async () => {
    useActiveModel.setState({ byTerminal: { t1: 'gpt-6-luna' } });
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-luna' })] } } as never);
    render(<ChatView terminalId="t1" />);
    await waitFor(() => expect(api.codexModelEfforts).toHaveBeenCalled());
    await typeAndEnter('/effort ultra');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Unknown effort "ultra"/));
    expect(setEffort).not.toHaveBeenCalled();
  });

  it('a model switch that brought the new default says so, and the card stays open to show it', async () => {
    useActiveModel.setState({ byTerminal: { t1: 'gpt-6-astra' } });
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-astra', effort: 'ultra' })] } } as never);
    setModel.mockResolvedValue({ model: 'gpt-6-luna', terminal: thread('codex'), clearedEffort: 'ultra', effortNow: 'low' });
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Luna/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Effort ultra is not available on this model, so it now runs at low.'));
  });

  it('an older daemon with no list falls back to the built-in table', async () => {
    (api.codexModelEfforts as any).mockRejectedValue(new Error('404'));
    useActiveModel.setState({ byTerminal: { t1: 'gpt-6-luna' } });
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-luna' })] } } as never);
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    expect(await screen.findByRole('radio', { name: 'max' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'ultra' })).toBeNull();
  });
});

describe('/cli asks first when the thread is working, and says why when it fails (round 1 item 8, round 2 item 7, round 3 item 4)', () => {
  const withSession = () => useTabs.setState({ byProject: { s1: [{ ...thread('claude-code', { model: 'sonnet' }), externalId: 'e1' }, { ...thread('claude-code'), id: 't2', externalId: 'e2' }] } } as never);

  it('switches at once when the thread is idle', async () => {
    withSession();
    const sw = vi.spyOn(api, 'switchTransport').mockResolvedValue(thread('claude-code'));
    await typeAndEnter('/cli');
    await waitFor(() => expect(sw).toHaveBeenCalledWith('t1', 'pty'));
  });

  it('while working it asks, and switches (with force) only on Stop and switch; Cancel leaves it', async () => {
    withSession();
    useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } });
    const sw = vi.spyOn(api, 'switchTransport').mockResolvedValue(thread('claude-code'));
    await typeAndEnter('/cli');
    expect(await screen.findByText(/Switch to CLI now\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sw).not.toHaveBeenCalled();
    await typeAndEnter('/cli');
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and switch' }));
    await waitFor(() => expect(sw).toHaveBeenCalledWith('t1', 'pty', { force: true }));
  });

  it('an immediate switch the daemon refuses shows its reason and keeps /cli in the box', async () => {
    withSession();
    vi.spyOn(api, 'switchTransport').mockRejectedValue(new Error('This thread is busy. Wait for the current turn to finish, then switch.'));
    await typeAndEnter('/cli');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This thread is busy'));
    expect((await box()).value).toBe('/cli');
  });

  it('a thread with no session yet says why it cannot switch', async () => {
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code'), externalId: null }] } } as never);
    const sw = vi.spyOn(api, 'switchTransport');
    await typeAndEnter('/cli');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Send a message first/));
    expect(sw).not.toHaveBeenCalled();
  });

  async function failedAfterConfirm() {
    withSession();
    useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } });
    vi.spyOn(api, 'switchTransport').mockRejectedValue(new Error('No session to resume yet'));
    const view = render(<ChatView terminalId="t1" />);
    const ta = await box();
    fireEvent.change(ta, { target: { value: '/cli' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and switch' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not switch: No session to resume yet'));
    return view;
  }

  it('a switch refused after the confirmation shows its reason in the thread; the line goes when the mode changes some other way', async () => {
    await failedAfterConfirm();
    act(() => useTabs.setState({ byProject: { s1: [{ ...thread('claude-code', { transport: 'pty' }), externalId: 'e1' }] } } as never));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('the line does not follow the pane to another thread, and has a close button', async () => {
    const view = await failedAfterConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Could not switch/)).toBeNull();
    view.unmount();
    const again = await failedAfterConfirm();
    again.rerender(<ChatView terminalId="t2" />);
    await waitFor(() => expect(screen.queryByText(/Could not switch/)).toBeNull());
  });
});

describe('a refused change is shown in the thread (round 1 items 6 and 10)', () => {
  it('a notice from the daemon becomes a visible error line in the thread', async () => {
    render(<ChatView terminalId="t1" />);
    await screen.findByPlaceholderText('Message…');
    act(() => onEvent!({ type: 'system', subtype: 'settings_refused', message: "Could not change the model: Model 'x' not found" }));
    expect(await screen.findByText("Could not change the model: Model 'x' not found")).toBeInTheDocument();
  });
});
