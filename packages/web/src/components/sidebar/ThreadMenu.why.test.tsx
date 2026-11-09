import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThreadMenu } from './ThreadMenu';
import { usePluginRegistry } from '../../plugins/registry';
import { api } from '../../api/client';
import type { Terminal, ThreadDiagnostics } from '../../api/types';

// W2-G: the thread menu opens the "Why is this thread in this state?" panel.

const tab = (over: Partial<Terminal> = {}): Terminal => ({ id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix the login bug', config: {}, status: 'working', createdAt: '2026-11-07T00:00:00Z', ...over } as Terminal);
const answer: ThreadDiagnostics = {
  lifecycle: null, captureFailure: null, events: [], status: 'working', transport: 'structured', process: { alive: false, transport: 'structured' },
  stall: null, park: null, pendingQuestion: null, deliveries: [],
  explanation: { rule: 'working-dead-process', headline: 'Working, but the process ended', since: null, reasons: ['No process runs for this thread.'], nextSteps: [{ label: 'Reset status', action: 'reset-status' }] },
};

function viewport(phone: boolean) {
  Object.defineProperty(window, 'innerWidth', { value: phone ? 390 : 1440, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

function Host({ t }: { t: Terminal }) {
  return <ThreadMenu at={{ tab: t, x: 40, y: 60 }} onClose={() => {}} onBranched={() => {}} />;
}

beforeEach(() => {
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {} });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each([['desktop', false], ['phone', true]] as const)('the "Why is this thread in this state?" menu item (%s)', (_name, phone) => {
  beforeEach(() => viewport(phone));

  it('is a row under More, with an icon and one line that explains it', () => {
    render(<Host t={tab()} />);
    expect(screen.queryByRole('button', { name: 'Why is this thread in this state?' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const row = screen.getByRole('button', { name: 'Why is this thread in this state?' });
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row.textContent).toContain('Explains the status and lists the last events');
  });

  it('opens the panel for that thread in a dialog', async () => {
    const load = vi.spyOn(api, 'getThreadDiagnostics').mockResolvedValue(answer);
    render(<Host t={tab()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Why is this thread in this state?' }));
    const dialog = await screen.findByRole('dialog', { name: 'Why is this thread in this state?' });
    expect(await within(dialog).findByRole('heading', { name: 'Working, but the process ended' })).toBeTruthy();
    expect(load).toHaveBeenCalledWith('t1');
    expect(within(dialog).getByRole('button', { name: 'Reset status' })).toBeTruthy();
  });

  it('is not offered for a file tab', () => {
    render(<Host t={tab({ type: 'file' })} />);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Why is this thread in this state?' })).toBeNull();
  });
});
