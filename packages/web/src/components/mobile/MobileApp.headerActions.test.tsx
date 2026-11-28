import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { MobileApp } from './MobileApp';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useProjectsView } from '../../stores/projectsView';
import { useMobileNav } from '../../stores/mobileNav';
import { useThreadStatus } from '../../stores/threadStatus';
import { useSectionCollapse } from '../../stores/sectionCollapse';
import { __resetAttentionForTest } from '../../lib/attention';
import { api } from '../../api/client';
import { usePluginRegistry } from '../../plugins/registry';

// Owner, 2026-11-27: "On the projects view the plus and sort buttons are above besides the search, on
// threads view they are below. Put them at the top just like projects." On the phone both lists put
// their two buttons in the app header, right of the search, at one size; the row under the
// Projects/Threads switch holds only the ACTIVE / ARCHIVED tabs.

vi.mock('../sidebar/NewThreadModal', () => ({
  NewThreadModal: (p: any) => <div role="dialog" aria-label="New thread"><span data-testid="pick">{String(!!p.pickProject)}</span></div>,
}));

const t = (id: string, sessionId: string, label: string) =>
  ({ id, sessionId, type: 'shell', label, status: 'waiting', config: {}, archivedAt: null, createdAt: '2026-11-09T10:00:00Z', lastActivityAt: '2026-11-09T10:00:00Z' }) as any;

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: window.innerWidth <= 768, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  localStorage.clear();
  useProjectsView.setState({ view: 'projects' });
  useMobileNav.setState({ sub: null });
  useSectionCollapse.setState({ collapsed: {} });
  useThreadStatus.setState({ byTerminal: {}, stalls: {} });
  __resetAttentionForTest();
  useProjects.setState({ sessions: [{ id: 's1', name: 'Proj', workingDir: '/tmp/p', provider: 'claude-code', status: 'waiting' }] as any, activeId: null });
  const lists: Record<string, any[]> = { s1: [t('t1', 's1', 'Fix it')] };
  useTabs.setState({ byProject: { ...lists }, openTabIds: [], activeTabId: null, tabSession: {} });
  vi.spyOn(api, 'listSessions').mockResolvedValue([] as any);
  vi.spyOn(api, 'listTerminals').mockImplementation(async (pid: string) => lists[pid] ?? []);
  vi.spyOn(api, 'getTerminal').mockReturnValue(new Promise(() => {}) as any);
  vi.spyOn(api, 'listStalls').mockResolvedValue([]);
  vi.spyOn(api, 'getAccounts').mockRejectedValue(new Error('no accounts route'));
  vi.spyOn(api, 'listPlugins').mockResolvedValue({ plugins: [] } as any);
  vi.spyOn(api, 'listMarketplaces').mockResolvedValue({ marketplaces: [] } as any);
  vi.spyOn(api, 'pluginCatalog').mockResolvedValue({ entries: [] } as any);
  usePluginRegistry.setState({ views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [], manifests: [], status: {}, badges: {} });
  window.history.pushState({}, '', '/');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.pushState({}, '', '/'); });

const header = () => document.querySelector('header') as HTMLElement;
/** The header's search box and the two buttons after it, in order. */
const headerRow = (search: string, second: RegExp, plus: string) => {
  const h = within(header());
  const box = h.getByPlaceholderText(search);
  const b2 = h.getByRole('button', { name: second });
  const add = h.getByRole('button', { name: plus });
  expect(box.compareDocumentPosition(b2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(b2.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  return { b2, add };
};

describe('the phone header buttons of Projects and Threads', () => {
  it('Projects: search, Sort, + in the header', () => {
    render(<MobileApp />);
    const { b2, add } = headerRow('Search projects', /^Sort/, 'New project');
    expect(add.style.background).toBe('var(--color-accent)');
    expect([b2.style.width, b2.style.height, add.style.width, add.style.height]).toEqual(['36px', '36px', '36px', '36px']);
  });

  it('Threads: search, Filters, + in the header at the Projects size, and none of them under the switch', () => {
    useProjectsView.setState({ view: 'threads' });
    render(<MobileApp />);
    const { b2, add } = headerRow('Search threads', /^Filters/, 'New thread');
    expect(add.style.background).toBe('var(--color-accent)');
    expect([b2.style.height, add.style.width, add.style.height]).toEqual(['36px', '36px', '36px']);
    expect(b2.style.borderRadius).toBe('var(--radius-md)');
    expect(add.style.borderRadius).toBe('var(--radius-md)');
    // Shown once: the row under the switch holds only the tabs.
    expect(screen.getAllByRole('button', { name: /^Filters/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'New thread' })).toHaveLength(1);
    const row = screen.getByTestId('thread-list-tabs').closest('[data-filterbar-row]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /^Filters/ })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'New thread' })).toBeNull();
    expect(within(row).getAllByRole('tab').map((x) => x.textContent)).toEqual(['ACTIVE', 'ARCHIVED']);
  });

  it('Threads: the header buttons keep their jobs (Filters opens the filters, + the new-thread dialog with a project picker)', () => {
    useProjectsView.setState({ view: 'threads' });
    render(<MobileApp />);
    fireEvent.click(within(header()).getByRole('button', { name: /^Filters/ }));
    expect(screen.getByTestId('filters-panel')).toBeInTheDocument();
    fireEvent.click(within(header()).getByRole('button', { name: 'New thread' }));
    expect(screen.getByTestId('pick')).toHaveTextContent('true');
  });

  it('back on Projects, the Threads buttons leave the header', () => {
    useProjectsView.setState({ view: 'threads' });
    render(<MobileApp />);
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(within(header()).queryByRole('button', { name: /^Filters/ })).toBeNull();
    expect(within(header()).queryByRole('button', { name: 'New thread' })).toBeNull();
    headerRow('Search projects', /^Sort/, 'New project');
  });
});
