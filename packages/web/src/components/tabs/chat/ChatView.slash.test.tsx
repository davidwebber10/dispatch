// The "/" menu and the model/effort picker in a Pretty thread (slash menu, 2026-11-06).
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ChatView } from './ChatView';
import { api } from '../../../api/client';
import * as sock from '../../../api/structured-socket';
import { useTabs } from '../../../stores/tabs';
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
