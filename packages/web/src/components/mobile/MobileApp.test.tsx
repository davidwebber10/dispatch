import { render, screen, fireEvent } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { MobileApp } from './MobileApp';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import * as sock from '../../api/structured-socket';

// The CLI ⇄ Pretty transport switch was only ever wired into TabHost's DESKTOP floating
// control, so on a phone the header offered just the old View/Terminal `ModeToggle` — and a
// Pretty thread (for which ModeToggle deliberately renders nothing) had no switch at all.
// MobileApp derives its level-2 thread leaf from the URL, so seeding `/p/{project}/t/{tab}`
// mounts it straight onto the thread screen where the header control belongs.

// Also kept outside the store so a getTerminal promise still in flight when the next test
// resets the store resolves benignly instead of rejecting unhandled.
let seeded: Record<string, unknown> | null = null;

function seedThreadAt(path: string, tab: Record<string, unknown>) {
  window.history.pushState({}, '', path);
  seeded = { id: 't1', sessionId: 's1', type: 'claude-code', config: {}, ...tab };
  useTabs.setState({ byProject: { s1: [seeded as any] } });
}

beforeEach(() => {
  // Present as a phone: TabHost gates its own floating desktop TransportToggle on
  // `!isMobile`, so without this jsdom's default 1024px viewport renders BOTH controls and
  // the header assertion below can't tell which one it found.
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: window.innerWidth <= 768,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
  vi.restoreAllMocks();
  vi.spyOn(api, 'listSessions').mockResolvedValue([] as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([] as any);
  // TabHost/TerminalTab re-fetch the thread on mount; answer from the seeded store so the
  // real (unroutable in jsdom) /api/terminals call never fires.
  vi.spyOn(api, 'getTerminal').mockImplementation(async (id: string) => {
    for (const list of Object.values(useTabs.getState().byProject)) {
      const t = list.find((x) => x.id === id);
      if (t) return t as any;
    }
    return (seeded ?? { id, sessionId: 's1', type: 'shell', config: {} }) as any;
  });
  // ChatView (the Pretty thread body) opens a live ws on mount — stub it out.
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation(() => ({ close: () => {} }) as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('MobileApp header — CLI ⇄ Pretty transport switch', () => {
  it('renders the TransportToggle for a Pretty (structured) claude-code thread', () => {
    seedThreadAt('/p/s1/t/t1', { type: 'claude-code', externalId: 'e1', config: { transport: 'structured' } });
    render(<MobileApp />);
    const group = screen.getByRole('group', { name: 'Transport' });
    expect(group).toBeInTheDocument();
    // Both segments are offered, so the thread can be switched back to CLI from a phone.
    expect(screen.getByRole('button', { name: /^CLI$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Pretty$/ })).toBeInTheDocument();
  });

  it('renders it for a CLI claude-code thread too (both transports get the switch)', () => {
    seedThreadAt('/p/s1/t/t1', { type: 'claude-code', externalId: 'e1', config: {} });
    render(<MobileApp />);
    expect(screen.getByRole('group', { name: 'Transport' })).toBeInTheDocument();
  });

  it('renders nothing for a non-AI (shell) thread — TransportToggle self-gates', () => {
    seedThreadAt('/p/s1/t/t1', { type: 'shell', externalId: 'e1', config: {} });
    render(<MobileApp />);
    expect(screen.queryByRole('group', { name: 'Transport' })).not.toBeInTheDocument();
  });

  it('renders nothing on the project list (no thread selected)', () => {
    seedThreadAt('/', { type: 'claude-code', externalId: 'e1', config: { transport: 'structured' } });
    render(<MobileApp />);
    expect(screen.queryByRole('group', { name: 'Transport' })).not.toBeInTheDocument();
  });
});

// Settings moved off the header gear (a modal, which on a phone left the sections
// cramped inside a 520px box) and onto the bottom rail as a real destination, so it
// drills down like every other mobile screen.
describe('MobileApp — Settings as a bottom-rail destination', () => {
  it('offers Settings as a bottom tab', () => {
    seedThreadAt('/', { type: 'shell', config: {} });
    render(<MobileApp />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('no longer renders the header gear button', () => {
    seedThreadAt('/', { type: 'shell', config: {} });
    render(<MobileApp />);
    // The old control was a 32px icon button carrying title="Settings"; the bottom
    // tab is a labelled button, so the title lookup is what distinguishes them.
    expect(screen.queryByTitle('Settings')).not.toBeInTheDocument();
  });

  it('shows the section list on the Settings tab, and drills into a section', () => {
    seedThreadAt('/', { type: 'shell', config: {} });
    render(<MobileApp />);
    fireEvent.click(screen.getByText('Settings'));
    // The list is the level-0 screen: every section is offered.
    expect(screen.getByText('Transcription')).toBeInTheDocument();
    expect(screen.getByText('Secrets')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Transcription'));
    // Drilling in pushes a history entry so back / edge-swipe walk out of it, and the
    // back button labels the screen it returns TO (iOS convention).
    expect(history.state).toMatchObject({ nav: 1, settingsSection: 'transcription' });
  });
});
