import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FilterBar, type FilterFacet } from './FilterBar';

const PROJECTS = [{ value: 'a', label: 'Alpha', count: 3 }, { value: 'b', label: 'Beta', count: 1 }];
const MANY = Array.from({ length: 12 }, (_, i) => ({ value: `t${i}`, label: `Thread ${i}` }));

function Harness({ variant = 'popover' as 'popover' | 'sheet', onClear }: { variant?: 'popover' | 'sheet'; onClear?: () => void }) {
  const [q, setQ] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [thread, setThread] = useState<string | null>(null);
  const facets: FilterFacet[] = [
    { id: 'project', title: 'Project', allLabel: 'All projects', value: project, options: PROJECTS, onChange: setProject },
    { id: 'thread', title: 'Thread', allLabel: 'All threads', value: thread, options: MANY, onChange: setThread },
  ];
  return <FilterBar variant={variant} query={q} onQueryChange={setQ} placeholder="Search things" facets={facets} onClear={onClear} />;
}

describe('FilterBar', () => {
  it('is one row: the search, then the Filters button to its right; no pills while nothing is on', () => {
    render(<Harness />);
    const search = screen.getByRole('searchbox', { name: 'Search things' });
    const button = screen.getByRole('button', { name: 'Filters' });
    expect(search.closest('[data-filterbar-row]')).toBe(button.closest('[data-filterbar-row]'));
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('applied-filters')).toBeNull();
    fireEvent.change(search, { target: { value: 'hi' } });
    expect(search).toHaveValue('hi');
  });

  it('opens a panel with one section per facet; each lists All plus its options with counts', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    const group = within(panel).getByRole('group', { name: 'Project filter' });
    const rows = within(group).getAllByRole('button');
    expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual(['All projects', 'Alpha', 'Beta']);
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
    expect(rows[1].textContent).toContain('3');
    expect(within(panel).getByRole('button', { name: 'Thread: All threads' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('a pick is single-select, counts on the button, and shows as a removable pill once the panel closes', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Project: Beta' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filters, 1 on' }));
    expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
    const pills = screen.getByTestId('applied-filters');
    expect(pills).toHaveTextContent('Project');
    expect(pills).toHaveTextContent('Beta');
    fireEvent.click(within(pills).getByRole('button', { name: 'Remove Project filter' }));
    expect(screen.queryByTestId('applied-filters')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('a facet with many options has its own search box', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.queryByRole('searchbox', { name: 'Search project' })).toBeNull();
    const box = screen.getByRole('searchbox', { name: 'Search thread' });
    fireEvent.change(box, { target: { value: 'thread 1' } });
    const labels = within(screen.getByRole('group', { name: 'Thread filter' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['All threads', 'Thread 1', 'Thread 10', 'Thread 11']);
  });

  it('Clear resets every facet (the pills row and the panel footer), and calls onClear', () => {
    const onClear = vi.fn();
    render(<Harness onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Thread 3' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Filters' })).getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'All projects' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(within(screen.getByTestId('applied-filters')).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('applied-filters')).toBeNull();
  });

  it('Escape closes the popover', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Filters' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull();
  });

  it('the sheet variant holds the same sections', () => {
    render(<Harness variant="sheet" />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('group', { name: 'Project filter' })).toBeInTheDocument();
    expect(screen.getByTestId('filters-panel')).toBeInTheDocument();
  });

  it('a segmented facet is a radio row with an All choice at the end', () => {
    const onChange = vi.fn();
    render(<FilterBar variant="popover" facets={[{ id: 's', title: 'Started by', display: 'segmented', value: null, allLabel: 'All', allCount: 5, onChange,
      options: [{ value: 'mine', label: 'Mine', count: 2 }, { value: 'agents', label: 'Agents', count: 3 }] }]} />);
    expect(screen.queryByRole('searchbox')).toBeNull(); // no search without onQueryChange
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const radios = within(screen.getByRole('radiogroup', { name: 'Started by' })).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Mine 2', 'Agents 3', 'All 5']);
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radios[0]);
    expect(onChange).toHaveBeenCalledWith('mine');
  });

  it('`leading` takes the search\'s place in the row', () => {
    render(<FilterBar variant="popover" leading={<span>Tabs here</span>} facets={[]} />);
    expect(screen.getByText('Tabs here').closest('[data-filterbar-row]')).toBe(screen.getByRole('button', { name: 'Filters' }).closest('[data-filterbar-row]'));
  });
});
