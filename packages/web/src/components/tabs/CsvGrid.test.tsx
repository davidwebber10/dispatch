import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CsvGrid } from './CsvGrid';

const CSV = 'name,qty\napples,3\npears,5\n';

describe('CsvGrid', () => {
  it('renders the header and the cells', () => {
    render(<CsvGrid content={CSV} onChange={() => {}} />);
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('apples')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('commits a cell edit on Enter and emits the new CSV text', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} onChange={onChange} />);

    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bananas' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Only the edited line changes; the header and the pears row stay byte-identical.
    expect(onChange).toHaveBeenCalledWith('name,qty\nbananas,3\npears,5\n');
  });

  it('quotes a committed value that contains the delimiter', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'apples, green' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('name,qty\n"apples, green",3\npears,5\n');
  });

  it('Escape cancels the edit and emits nothing', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('apples')).toBeInTheDocument();
  });

  it('adds a row', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Add row'));
    expect(onChange).toHaveBeenCalledWith('name,qty\napples,3\npears,5\n,\n');
  });

  it('deletes a row without disturbing the others', () => {
    const onChange = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CsvGrid content={CSV} onChange={onChange} />);
    fireEvent.click(screen.getAllByTitle('Delete row')[0]); // first DATA row (apples)
    expect(onChange).toHaveBeenCalledWith('name,qty\npears,5\n');
  });

  it('refuses to render a grid over a file it could not parse', () => {
    render(<CsvGrid content={'a,b\n"unterminated,2\n'} onChange={() => {}} />);
    expect(screen.getByText(/could not be parsed/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();   // never a half-parsed grid
  });

  it('windows the rows — a huge file renders only a slice of the DOM', () => {
    const big = 'a,b\n' + Array.from({ length: 20_000 }, (_, i) => `${i},${i}`).join('\n') + '\n';
    render(<CsvGrid content={big} onChange={() => {}} />);
    // 20k data rows exist in the doc but nowhere near that many <tr> are in the DOM.
    expect(screen.getAllByRole('row').length).toBeLessThan(200);
  });
});
