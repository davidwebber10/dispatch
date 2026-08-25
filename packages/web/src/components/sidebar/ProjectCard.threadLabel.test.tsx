import { AGENT_TYPES, HARNESSES, THREAD_TYPES } from '../../lib/harnesses';
import { providerColor } from '../common/typeIcons';
// Finding 3: reverting ProjectCard's `<ThreadLabel tab={tab} />` (ProjectCard.tsx ~line 131,
// inside ThreadRow) back to the original `<span>{tab.label}</span>` passes the ENTIRE web
// suite — ThreadLabel.test.tsx exercises the component directly, and ThreadRow.autoArchive
// .test.tsx / ProjectSidebar.test.tsx only assert with getByText, which matches either markup.
// Route a real default->auto transition through the actual ProjectCard tree (SortableList ->
// ThreadRow -> ThreadLabel) and assert on `.dispatch-caret`, which only ThreadLabel ever
// renders — this fails immediately if the wiring is reverted.
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import type { Session, Terminal } from '../../api/types';

const NOW = new Date('2026-07-19T12:00:00.000Z').getTime();

const session: Session = {
  id: 's1', provider: 'claude-code', name: 'proj', notes: '', status: 'waiting',
  workingDir: '/tmp/proj', tags: [], pid: null, createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z', lastActivityAt: '2026-07-14T00:00:00.000Z', archivedAt: null,
};

const thread: Terminal = {
  id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix login bug', labelSource: 'auto',
  pid: null, externalId: null, workingDir: null, status: 'waiting',
  createdAt: '2026-07-14T11:00:00.000Z', lastActivityAt: '2026-07-14T11:00:00.000Z', config: {}, archivedAt: null, sortOrder: 0,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // ProjectCard's mount effect calls loadTabs → api.listTerminals; stub it so the component
  // doesn't fire a real fetch() (unhandled rejection under jsdom) and clobber the byProject /
  // autoNamed fixtures seeded below before the layout effect gets a chance to run.
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
  useTabs.setState({
    byProject: { s1: [thread] },
    autoNamed: { t1: { from: 'Claude Code', to: 'Fix login bug', at: NOW } },
    loading: {},
  } as any);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('a thread with a live default->auto transition renders through ThreadLabel (not a plain span) inside ProjectCard', () => {
  render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
  // Only ThreadLabel ever renders a caret — a plain `<span>{tab.label}</span>` cannot.
  expect(document.querySelector('.dispatch-caret')).not.toBeNull();
  // The true label is still exposed to assistive tech while the animation plays.
  expect(screen.getByLabelText('Fix login bug')).toBeInTheDocument();
});

describe('a Grok thread belongs in the sidebar', () => {
  it('lists grok alongside claude-code, codex and shell in the THREADS section', () => {
    // The regression: adding Grok as a provider missed this allow-list, so Grok threads
    // ran but never appeared. Assert the constant, not the rendering, so the guarantee
    // survives any layout change.
    expect(AGENT_TYPES).toContain('grok');
    expect(THREAD_TYPES).toContain('grok');
    expect(THREAD_TYPES).toEqual(expect.arrayContaining(['claude-code', 'codex', 'grok', 'shell']));
  });

  it('derives both lists from HARNESSES, so one entry adds a harness everywhere', () => {
    // This is the guard: a harness added to HARNESSES cannot be missing from the sidebar,
    // because the sidebar's list IS HARNESSES.
    expect(THREAD_TYPES).toEqual(HARNESSES.map((h) => h.type));
    expect(AGENT_TYPES).toEqual(HARNESSES.filter((h) => h.provider !== null).map((h) => h.type));
  });

  it('gives every agent harness a provider and every harness a wire type', () => {
    for (const h of HARNESSES) {
      expect(h.type, `${h.label} has no wire type`).toBeTruthy();
      if (h.id !== 'terminal') expect(h.provider, `${h.label} has no CLI`).toBeTruthy();
    }
  });

  it('gives Grok its own provider dot rather than the neutral fallback', () => {
    expect(providerColor('grok')).not.toBe(providerColor('shell'));
    expect(providerColor('grok')).not.toBe(providerColor('claude-code'));
  });
});

describe('every harness is visually distinguishable', () => {
  it('gives each agent harness its own provider dot', () => {
    // A harness with no colour of its own falls through to the neutral grey used for a
    // plain shell, so it looks like a terminal in the sidebar.
    const shell = providerColor('shell');
    const seen = new Map<string, string>();
    for (const h of HARNESSES) {
      if (h.provider === null) continue;
      const c = providerColor(h.type);
      expect(c, `${h.label} has no colour of its own`).not.toBe(shell);
      expect(seen.has(c), `${h.label} shares a colour with ${seen.get(c)}`).toBe(false);
      seen.set(c, h.label);
    }
  });
});
