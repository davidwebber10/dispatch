import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { buildSdk } from './sdk';
import { createPluginSdk } from './facade';
import { FilterBar } from '../components/common/FilterBar';
import { Select } from '../components/common/Select';
import { useProjects } from '../stores/projects';
// The bundled Previews plugin is plain JS.
import activate, { NAME } from '../../../plugins/previews/web.js';

const p = (id: string, sessionId: string, terminalId: string, terminalLabel: string, createdAt: string) =>
  ({ id, sessionId, sessionName: sessionId, terminalId, terminalLabel, title: `Preview ${id}`, note: null, text: 'x', files: [], createdAt, seenAt: 'seen' });
const DOCS = [
  p('a', 's1', 't1', 'Fix login', '2026-11-07T10:00:00Z'),
  p('b', 's2', 't2', 'Release', '2026-11-07T11:00:00Z'),
  p('c', 's2', 't3', 'Charts', '2026-11-07T12:00:00Z'),
];

describe('the SDK exposes the shared controls (2026-11-07)', () => {
  it('d.ui.FilterBar and d.ui.Select are the app\'s own components', () => {
    const d = buildSdk();
    expect(d.ui.FilterBar).toBe(FilterBar);
    expect(d.ui.Select).toBe(Select);
  });
});

describe('the Previews history filters are the shared FilterBar (2026-11-07)', () => {
  let History: React.ComponentType;
  beforeEach(() => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }, { id: 's2', name: 'Beta' }] as never });
    const base = createPluginSdk('previews');
    const views: { Component: React.ComponentType }[] = [];
    const d = {
      ...base,
      docs: { ...base.docs, entries: vi.fn(async () => DOCS.map((v) => ({ key: `preview:${v.id}`, value: v }))), set: vi.fn(async () => {}) },
      events: { on: () => () => {} },
      register: (c: { views: { Component: React.ComponentType }[] }) => { views.push(...c.views); },
    };
    activate(d as never);
    History = views[0].Component;
  });

  it('one row: the search, then Filters; no native select; Project and Thread are the facets', async () => {
    render(<History />);
    await screen.findByText('Preview a');
    const search = screen.getByRole('searchbox', { name: 'Search items' });
    const filters = screen.getByRole('button', { name: 'Filters' });
    expect(search.closest('[data-filterbar-row]')).toBe(filters.closest('[data-filterbar-row]'));
    expect(document.querySelector('select')).toBeNull();
    fireEvent.click(filters);
    expect(within(screen.getByRole('group', { name: 'Project filter' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['All projects', 'Alpha', 'Beta']);
    expect(within(screen.getByRole('group', { name: 'Thread filter' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['All threads', 'Charts', 'Fix login', 'Release']);
  });

  it('a project narrows the list and the thread choices; the pick shows as a pill', async () => {
    render(<History />);
    await screen.findByText('Preview a');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(within(screen.getByRole('group', { name: 'Thread filter' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['All threads', 'Charts', 'Release']);
    fireEvent.click(screen.getByRole('button', { name: 'Charts' }));
    expect(screen.queryByText('Preview a')).toBeNull();
    expect(screen.queryByText('Preview b')).toBeNull();
    expect(screen.getByText('Preview c')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filters, 2 on' }));
    const pills = screen.getByTestId('applied-filters');
    expect(pills).toHaveTextContent('ProjectBeta');
    expect(pills).toHaveTextContent('ThreadCharts');
    // Another project drops a thread that is not in it.
    fireEvent.click(within(pills).getByRole('button', { name: 'Remove Project filter' }));
    await waitFor(() => expect(screen.getByText('Preview c')).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId('applied-filters')).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('applied-filters')).toBeNull();
    expect(screen.getByText('Preview a')).toBeInTheDocument();
  });
});
