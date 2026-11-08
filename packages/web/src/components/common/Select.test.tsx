import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Select } from './Select';

const UNITS = [{ value: 'minutes', label: 'Minutes' }, { value: 'hours', label: 'Hours' }, { value: 'days', label: 'Days' }];

describe('Select', () => {
  it('is a combobox that shows the current label; a short list opens without a search box', () => {
    render(<Select ariaLabel="Unit" value="hours" options={UNITS} onChange={() => {}} />);
    const trigger = screen.getByRole('combobox', { name: 'Unit' });
    expect(trigger).toHaveTextContent('Hours');
    fireEvent.click(trigger);
    expect(screen.queryByRole('textbox')).toBeNull();
    const list = screen.getByRole('listbox', { name: 'Unit' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Minutes', 'Hours', 'Days']);
    expect(within(list).getByRole('option', { name: 'Hours' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the keyboard drives it: arrows move, Enter picks, Escape closes', () => {
    const onChange = vi.fn();
    render(<Select ariaLabel="Unit" value="minutes" options={UNITS} onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Unit' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox', { name: 'Unit' });
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('hours');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a letter jumps to the next option that starts with it', () => {
    const onChange = vi.fn();
    render(<Select ariaLabel="Unit" value="minutes" options={UNITS} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Unit' }), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'd' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('days');
  });

  it('a click on an option picks it', () => {
    const onChange = vi.fn();
    render(<Select ariaLabel="Unit" value="minutes" options={UNITS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Unit' }));
    fireEvent.click(screen.getByRole('option', { name: 'Days' }));
    expect(onChange).toHaveBeenCalledWith('days');
  });

  it('a long list gets a search box', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ value: `p${i}`, label: `Project ${i}` }));
    render(<Select ariaLabel="Project" value="p0" options={many} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    expect(screen.getByRole('textbox', { name: 'Search project' })).toBeInTheDocument();
  });

  it('takes an id, so a <label htmlFor> names it', () => {
    render(<><label htmlFor="pick-unit">Unit of time</label><Select id="pick-unit" value="days" options={UNITS} onChange={() => {}} /></>);
    expect(screen.getByRole('combobox', { name: 'Unit of time' })).toHaveTextContent('Days');
  });
});
