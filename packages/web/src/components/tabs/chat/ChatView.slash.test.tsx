// The "/" menu and the model/effort picker in a Pretty thread (slash menu, 2026-11-06).
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ChatView } from './ChatView';
import { api } from '../../../api/client';
import * as sock from '../../../api/structured-socket';
import { useTabs } from '../../../stores/tabs';
import { useThreadStatus } from '../../../stores/threadStatus';
import { resetCodexEffortsCache } from '../../composer/ThreadModelControl';
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
let settings: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.restoreAllMocks();
  // The live ws reports the model the CLI runs.
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation((h: any) => {
    setTimeout(() => h.onEvent?.({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' }), 0);
    return { close: () => {} } as any;
  });
  send = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(api, 'sendStructuredMessage').mockImplementation(send as never);
  settings = vi.fn().mockResolvedValue({ terminal: thread('claude-code'), applied: 'now' });
  vi.spyOn(api, 'setThreadSettings').mockImplementation(settings as never);
  vi.spyOn(api, 'getResumeAdvice').mockResolvedValue({ shouldPrompt: false, ageMinutes: 0, contextTokens: 0 });
  useTabs.setState({ byProject: { s1: [thread('claude-code', { model: 'sonnet' })] } } as never);
  useThreadStatus.setState({ byTerminal: {} });
  resetCodexEffortsCache();
});

const box = () => screen.findByPlaceholderText('Message…') as Promise<HTMLTextAreaElement>;
const typeAndEnter = async (text: string) => {
  if (!screen.queryByPlaceholderText('Message…')) render(<ChatView terminalId="t1" />);
  const ta = await box();
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.keyDown(ta, { key: 'Enter' });
};

describe('a Pretty thread: the "/" menu', () => {
  it('/effort high changes the effort and sends nothing to the model', async () => {
    await typeAndEnter('/effort high');
    await waitFor(() => expect(settings).toHaveBeenCalledWith('t1', { effort: 'high' }));
    expect(send).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Applies from the next turn'));
    expect((await box()).value).toBe('');
  });

  it('/model opus changes the model', async () => {
    await typeAndEnter('/model opus');
    await waitFor(() => expect(settings).toHaveBeenCalledWith('t1', { model: 'opus' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('a refused change shows the daemon\'s reason', async () => {
    settings.mockRejectedValueOnce(new Error("Model 'x' not found"));
    await typeAndEnter('/model haiku');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Model 'x' not found"));
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

  it('plain text still sends, an unknown /word goes as text, and a leading space escapes a command', async () => {
    await typeAndEnter('hello');
    expect(send).toHaveBeenLastCalledWith('t1', 'hello');
    await typeAndEnter('/frobnicate now');
    expect(send).toHaveBeenLastCalledWith('t1', '/frobnicate now');
    await typeAndEnter(' /model opus');
    expect(send).toHaveBeenLastCalledWith('t1', ' /model opus');
    expect(settings).not.toHaveBeenCalled();
  });

  it('typing / lists the commands above the box', async () => {
    render(<ChatView terminalId="t1" />);
    const ta = await box();
    fireEvent.change(ta, { target: { value: '/' } });
    expect(screen.getAllByRole('option').length).toBe(6);
  });
});

describe('a Pretty thread: the picker in the status row', () => {
  it('shows the model name as a button; picking a model calls the settings route', async () => {
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Sonnet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Haiku' }));
    await waitFor(() => expect(settings).toHaveBeenCalledWith('t1', { model: 'haiku' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Applies from the next turn'));
  });

  it('/model with no value opens the picker', async () => {
    render(<ChatView terminalId="t1" />);
    await typeAndEnter('/model');
    expect(await screen.findByRole('dialog', { name: 'Model and effort' })).toBeInTheDocument();
    expect(settings).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('a Grok thread', () => {
  it('shows the model as text and greys /model with a reason; nothing is sent', async () => {
    useTabs.setState({ byProject: { s1: [thread('grok')] } } as never);
    render(<ChatView terminalId="t1" />);
    await typeAndEnter('/model opus');
    expect(screen.getByRole('alert')).toHaveTextContent(/not yet available/i);
    expect(settings).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});


// ---- Review round 1 (PR #155) ----

describe('/cli asks first when the thread is working (item 8)', () => {
  it('switches at once when the thread is idle', async () => {
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code', { model: 'sonnet' }), externalId: 'e1' }] } } as never);
    const sw = vi.spyOn(api, 'switchTransport').mockResolvedValue(thread('claude-code'));
    vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
    await typeAndEnter('/cli');
    await waitFor(() => expect(sw).toHaveBeenCalledWith('t1', 'pty'));
  });

  it('while working it asks, and switches (with force) only on Stop and switch', async () => {
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code', { model: 'sonnet' }), externalId: 'e1' }] } } as never);
    useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } });
    const sw = vi.spyOn(api, 'switchTransport').mockResolvedValue(thread('claude-code'));
    await typeAndEnter('/cli');
    expect(await screen.findByText(/Switch to CLI now\?/)).toBeInTheDocument();
    expect(sw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and switch' }));
    await waitFor(() => expect(sw).toHaveBeenCalledWith('t1', 'pty', { force: true }));
  });

  it('Cancel leaves the thread alone', async () => {
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code'), externalId: 'e1' }] } } as never);
    useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } });
    const sw = vi.spyOn(api, 'switchTransport').mockResolvedValue(thread('claude-code'));
    await typeAndEnter('/cli');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(sw).not.toHaveBeenCalled();
  });

  it('a thread with no session yet says why it cannot switch', async () => {
    const sw = vi.spyOn(api, 'switchTransport');
    await typeAndEnter('/cli'); // thread() has externalId 'e'... make it empty
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code'), externalId: null }] } } as never);
    await typeAndEnter('/cli');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Send a message first/));
    expect(sw).not.toHaveBeenCalledWith('t1', 'pty', expect.anything());
  });
});

describe('a failed /cli says why (round 2, item 7)', () => {
  it('an immediate switch the daemon refuses shows its reason and keeps /cli in the box', async () => {
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code'), externalId: 'e1' }] } } as never);
    vi.spyOn(api, 'switchTransport').mockRejectedValue(new Error('This thread is busy. Wait for the current turn to finish, then switch.'));
    await typeAndEnter('/cli');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This thread is busy'));
    expect((await box()).value).toBe('/cli');
  });

  it('a switch refused after the confirmation shows its reason in the thread', async () => {
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code'), externalId: 'e1' }] } } as never);
    useThreadStatus.setState({ byTerminal: { t1: { threadStatus: 'working' } } });
    vi.spyOn(api, 'switchTransport').mockRejectedValue(new Error('No session to resume yet'));
    await typeAndEnter('/cli');
    fireEvent.click(await screen.findByRole('button', { name: 'Stop and switch' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not switch: No session to resume yet'));
  });

  it('a switch that works shows nothing', async () => {
    useTabs.setState({ byProject: { s1: [{ ...thread('claude-code'), externalId: 'e1' }] } } as never);
    vi.spyOn(api, 'switchTransport').mockResolvedValue(thread('claude-code'));
    vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
    await typeAndEnter('/cli');
    await waitFor(() => expect(api.switchTransport).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('a bad value keeps the typed text (item 7)', () => {
  it('/model banana is refused with a reason and stays in the box', async () => {
    await typeAndEnter('/model banana');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Unknown model "banana"/));
    expect((await box()).value).toBe('/model banana');
    expect(settings).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('a change the daemon refuses keeps the text too', async () => {
    settings.mockRejectedValueOnce(new Error("Model 'x' not found"));
    await typeAndEnter('/model haiku');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Model 'x' not found"));
    expect((await box()).value).toBe('/model haiku');
  });
});

describe('a refused change is shown in the thread (items 6 and 10)', () => {
  it('a notice from the daemon becomes a visible error line in the thread', async () => {
    let onEvent: ((e: any) => void) | undefined;
    vi.spyOn(sock, 'openStructuredSocket').mockImplementation((h: any) => { onEvent = h.onEvent; return { close: () => {} } as any; });
    render(<ChatView terminalId="t1" />);
    await screen.findByPlaceholderText('Message…');
    act(() => onEvent!({ type: 'system', subtype: 'settings_refused', message: "Could not change the model: Model 'x' not found" }));
    expect(await screen.findByText("Could not change the model: Model 'x' not found")).toBeInTheDocument();
  });

  it('the picker shows what the thread runs after the daemon rolled the config back', async () => {
    render(<ChatView terminalId="t1" />);
    await screen.findByRole('button', { name: /Sonnet/ });
    act(() => useTabs.setState({ byProject: { s1: [thread('claude-code', { model: 'opus' })] } } as never));
    expect(screen.getByRole('button', { name: /Opus/ })).toBeInTheDocument();
    act(() => useTabs.setState({ byProject: { s1: [thread('claude-code', { model: 'sonnet' })] } } as never)); // the reload after a rollback
    expect(await screen.findByRole('button', { name: /Sonnet/ })).toBeInTheDocument();
  });
});

describe('Codex efforts follow the model (item 9)', () => {
  const luna = ['low', 'medium', 'high', 'xhigh', 'max'];
  const astra = [...luna, 'ultra'];
  beforeEach(() => {
    vi.spyOn(api, 'codexModelEfforts').mockResolvedValue({ live: { 'gpt-6-luna': luna, 'gpt-6-astra': astra } });
  });

  it('the picker offers ultra for Astra and not for Luna', async () => {
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-astra' })] } } as never);
    const { unmount } = render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Astra/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'ultra' })).toBeInTheDocument());
    unmount();
    resetCodexEffortsCache();
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-luna' })] } } as never);
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /gpt-6-luna|Luna/ }));
    expect(await screen.findByRole('button', { name: 'max' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ultra' })).toBeNull();
  });

  it('/effort lists the current model\'s efforts', async () => {
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-luna' })] } } as never);
    render(<ChatView terminalId="t1" />);
    const ta = await box();
    await waitFor(() => expect(api.codexModelEfforts).toHaveBeenCalled());
    fireEvent.change(ta, { target: { value: '/effort ' } });
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.firstElementChild?.textContent)).toEqual(luna));
  });

  it('a model switch that dropped the effort says so', async () => {
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-astra', effort: 'ultra' })] } } as never);
    settings.mockResolvedValue({ terminal: thread('codex'), applied: 'now', clearedEffort: 'ultra', effortNow: 'medium' });
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Astra/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Luna/ }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Effort ultra is not available on this model, so it now runs at medium.'));
  });

  it('an older daemon with no list falls back to the built-in table', async () => {
    (api.codexModelEfforts as any).mockRejectedValue(new Error('404'));
    useTabs.setState({ byProject: { s1: [thread('codex', { model: 'gpt-6-luna' })] } } as never);
    render(<ChatView terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Luna|gpt-6-luna/ }));
    expect(await screen.findByRole('button', { name: 'max' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ultra' })).toBeNull();
  });
});
