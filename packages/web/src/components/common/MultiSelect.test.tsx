import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { MultiSelect, multiSummary } from './MultiSelect';

const OPTS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((l) => ({ value: l.toLowerCase(), label: l }));
afterEach(() => cleanup());

function Harness({ initial, onChange, variant }: { initial: string[]; onChange?: (v: string[]) => void; variant?: 'popover' | 'sheet' }) {
  const [v, setV] = useState(initial);
  return <MultiSelect ariaLabel="Projects" title="Projects" allLabel="All projects" noneLabel="No projects" options={OPTS} value={v} variant={variant} searchable
    onChange={(next) => { setV(next); onChange?.(next); }} />;
}

describe('multiSummary', () => {
  it('names all, none, "All except N" when fewer are off than on, else "N selected"', () => {
    const all = OPTS.map((o) => o.value);
    expect(multiSummary(all, all, {})).toBe('All');
    expect(multiSummary([], all, { noneLabel: 'Nothing' })).toBe('Nothing');
    expect(multiSummary(all.slice(0, 3), all, {})).toBe('All except 2');
    expect(multiSummary(all.slice(0, 2), all, {})).toBe('2 selected');
    expect(multiSummary(all.slice(0, 1), all, { noun: ['project', 'projects'] })).toBe('1 project');
    expect(multiSummary(all.slice(0, 2), all, { noun: ['project', 'projects'] })).toBe('2 projects');
  });
});

describe('MultiSelect (the shared multi-pick: a summary trigger and a checklist panel)', () => {
  it('the trigger shows the summary; the panel has a search, Select all, None and a checkbox per option', () => {
    const onChange = vi.fn();
    render(<Harness initial={['alpha', 'beta', 'gamma', 'delta', 'epsilon']} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Projects: All projects' });
    expect(trigger).toHaveTextContent('All projects');
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Projects' });
    expect(within(panel).getAllByRole('checkbox')).toHaveLength(5);
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Beta' }));
    expect(onChange).toHaveBeenLastCalledWith(['alpha', 'gamma', 'delta', 'epsilon']);
    expect(screen.getByRole('button', { name: 'Projects: All except 1' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'None' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(within(panel).getByRole('checkbox', { name: 'Alpha' })).not.toBeChecked();
    fireEvent.click(within(panel).getByRole('button', { name: 'Select all' }));
    expect(onChange).toHaveBeenLastCalledWith(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
  });

  it('the search narrows the list; Select all then picks only the shown options too', () => {
    const onChange = vi.fn();
    render(<Harness initial={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Projects: No projects' }));
    const panel = screen.getByRole('dialog', { name: 'Projects' });
    fireEvent.change(within(panel).getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'ta' } });
    expect(within(panel).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['Beta', 'Delta']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Select all' }));
    expect(onChange).toHaveBeenLastCalledWith(['beta', 'delta']);
    fireEvent.change(within(panel).getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'zzz' } });
    expect(within(panel).getByText('No matches')).toBeInTheDocument();
  });

  it('Done and Escape close the panel; the sheet variant opens in the shared sheet', () => {
    const { unmount } = render(<Harness initial={['alpha']} />);
    fireEvent.click(screen.getByRole('button', { name: /^Projects:/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Projects' })).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Projects:/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    render(<Harness initial={['alpha']} variant="sheet" />);
    fireEvent.click(screen.getByRole('button', { name: /^Projects:/ }));
    // On a desktop width the shared sheet opens as the centered modal (2026-11-07); on a phone it is the sheet.
    const dialog = screen.getAllByRole('dialog').at(-1)!;
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(5);
  });
});
