import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const { copyTextMock } = vi.hoisted(() => ({ copyTextMock: vi.fn((_t: string) => Promise.resolve()) }));
vi.mock('../../lib/clipboard', async (orig) => ({ ...(await orig<typeof import('../../lib/clipboard')>()), copyText: copyTextMock }));

import { CsvGrid } from './CsvGrid';

const CSV = 'name,qty\napples,3\npears,5\n';

/** The keyboard target: the grid's focusable scroll container. */
const gridOf = (container: HTMLElement) => container.querySelector('[tabindex="0"]') as HTMLElement;
/** The <td> for doc cell (r, c), r >= 1. Column 0 of each rendered row is the gutter. */
const cellOf = (container: HTMLElement, r: number, c: number) => {
  const tr = Array.from(container.querySelectorAll('tbody tr')).find((row) => row.firstElementChild?.textContent === String(r));
  return tr!.children[c + 1] as HTMLElement;
};

describe('CsvGrid', () => {
  it('renders the header and the cells', () => {
    render(<CsvGrid content={CSV} path="d.csv" onChange={() => {}} />);
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('apples')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('commits a cell edit on Enter and emits the new CSV text', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} path="d.csv" onChange={onChange} />);

    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bananas' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Only the edited line changes; the header and the pears row stay byte-identical.
    expect(onChange).toHaveBeenCalledWith('name,qty\nbananas,3\npears,5\n');
  });

  it('quotes a committed value that contains the delimiter', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} path="d.csv" onChange={onChange} />);
    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'apples, green' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('name,qty\n"apples, green",3\npears,5\n');
  });

  it('Escape cancels the edit and emits nothing', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} path="d.csv" onChange={onChange} />);
    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('apples')).toBeInTheDocument();
  });

  it('Escape guards against a same-tick blur re-committing the cancelled value', () => {
    // Proves the cancelledRef guard in CellInput. In a real browser, removing a focused element
    // fires a native blur BEFORE React has necessarily processed the resulting state update —
    // i.e. the blur can still reach an input whose surrounding React state already says
    // "cancelled". We reproduce that ordering by batching the Escape keydown and the blur into
    // a single `act()`: React queues the setEditing(null) update from onCancel() but does not
    // flush/unmount until the act() callback returns, so the blur below still reaches the *same*
    // mounted <input> — with cancelledRef already set to true by the keydown handler that ran
    // first. Without the guard this reproduces the exact failure Finding 2 describes: onBlur's
    // onCommit(null) reads the stale (pre-unmount) `editing` state and commits the discarded
    // draft. With the guard, onBlur must no-op and onChange must never fire.
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} path="d.csv" onChange={onChange} />);
    fireEvent.doubleClick(screen.getByText('apples'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'discard me' } });

    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.blur(input);
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('edits a header cell (renaming a column) and only changes the header line', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} path="d.csv" onChange={onChange} />);
    fireEvent.doubleClick(screen.getByText('name'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'item' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Only the header line changes; both data rows stay byte-identical.
    expect(onChange).toHaveBeenCalledWith('item,qty\napples,3\npears,5\n');
  });

  it('adds a row', () => {
    const onChange = vi.fn();
    render(<CsvGrid content={CSV} path="d.csv" onChange={onChange} />);
    fireEvent.click(screen.getByTitle('Add row'));
    expect(onChange).toHaveBeenCalledWith('name,qty\napples,3\npears,5\n,\n');
  });

  it('deletes a row without disturbing the others', () => {
    const onChange = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CsvGrid content={CSV} path="d.csv" onChange={onChange} />);
    fireEvent.click(screen.getAllByTitle('Delete row')[0]); // first DATA row (apples)
    expect(onChange).toHaveBeenCalledWith('name,qty\npears,5\n');
  });

  // The `path` prop is what makes parseCsv's .tsv branch reachable at all. A TSV whose cells contain
  // commas is the whole reason to choose TSV, and without the path it is detected as
  // comma-delimited — the grid shows the wrong cells and the first edit eats the tabs.
  it('parses a .tsv as tab-delimited and keeps the tabs when a cell is edited', () => {
    const onChange = vi.fn();
    const TSV = 'id\tnotes\n1\tred, green, blue\n2\ta, b, c\n';
    render(<CsvGrid content={TSV} path="d.tsv" onChange={onChange} />);

    // One cell, commas and all — not three columns.
    fireEvent.doubleClick(screen.getByText('red, green, blue'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'X' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('id\tnotes\n1\tX\n2\ta, b, c\n');
  });

  it('does not serve a cached doc across a path change (the delimiter depends on the path)', () => {
    const onChange = vi.fn();
    const TEXT = 'id\tnotes\n1\tred, green, blue\n';
    const { rerender } = render(<CsvGrid content={TEXT} path="d.csv" onChange={onChange} />);
    // As a .csv the commas win, so the notes cell is split — this row is NOT one cell.
    expect(screen.queryByText('red, green, blue')).toBeNull();

    // Same text, different path: the cache must re-parse, not hand back the comma-delimited doc.
    rerender(<CsvGrid content={TEXT} path="d.tsv" onChange={onChange} />);
    expect(screen.getByText('red, green, blue')).toBeInTheDocument();
  });

  it('refuses to render a grid over a file it could not parse', () => {
    render(<CsvGrid content={'a,b\n"unterminated,2\n'} path="d.csv" onChange={() => {}} />);
    expect(screen.getByText(/could not be parsed/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();   // never a half-parsed grid
  });

  it('windows the rows — a huge file renders only a slice of the DOM', () => {
    const big = 'a,b\n' + Array.from({ length: 20_000 }, (_, i) => `${i},${i}`).join('\n') + '\n';
    render(<CsvGrid content={big} path="d.csv" onChange={() => {}} />);
    // 20k data rows exist in the doc but nowhere near that many <tr> are in the DOM.
    expect(screen.getAllByRole('row').length).toBeLessThan(200);
  });

  it('measures the real scroll-container height on mount instead of trusting the hardcoded guess', () => {
    // Simulate a tall viewport (well above VIEWPORT_GUESS's fallback of a near-zero jsdom
    // clientHeight) by stubbing clientHeight before the component ever mounts. If viewportH is
    // only ever set from onScroll (the bug), this measurement is never taken and the window
    // stays sized off VIEWPORT_GUESS regardless of the real container height.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 2000 });
    try {
      const big = 'a,b\n' + Array.from({ length: 500 }, (_, i) => `${i},${i}`).join('\n') + '\n';
      render(<CsvGrid content={big} path="d.csv" onChange={() => {}} />);
      // A 2000px-tall viewport measured up front on first paint (no scroll yet) must render
      // far more rows than VIEWPORT_GUESS=600 would (~42 rows incl. header/gutter overhead).
      expect(screen.getAllByRole('row').length).toBeGreaterThan(60);
    } finally {
      // clientHeight lives on Element.prototype, so there is usually no own descriptor to put
      // back: delete the stub, or every later test in this file sees a 2000px viewport.
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  describe('selection', () => {
    beforeEach(() => { copyTextMock.mockReset(); copyTextMock.mockImplementation(() => Promise.resolve()); });

    it('Ctrl+C copies the selected rectangle as TSV, quoting cells that would split', async () => {
      const content = 'name,qty\n"a\tb",3\n"x\ny","say ""hi"""\n';
      const { container } = render(<CsvGrid content={content} path="d.csv" onChange={() => {}} />);
      fireEvent.mouseDown(cellOf(container, 1, 0));
      fireEvent.mouseDown(cellOf(container, 2, 1), { shiftKey: true });
      await act(async () => { fireEvent.keyDown(gridOf(container), { key: 'c', ctrlKey: true }); });
      expect(copyTextMock).toHaveBeenCalledWith('"a\tb"\t3\n"x\ny"\t"say ""hi"""');
    });

    it('a mousedown inside the open editor leaves it open and does not block the caret', () => {
      const onChange = vi.fn();
      render(<CsvGrid content={CSV} path="d.csv" onChange={onChange} />);
      fireEvent.doubleClick(screen.getByText('apples'));
      const input = screen.getByRole('textbox');

      const notPrevented = fireEvent.mouseDown(input);
      expect(notPrevented).toBe(true);
      expect(screen.getByRole('textbox')).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('Escape in the editor gives focus back to the grid, so the grid keys keep working', () => {
      const { container } = render(<CsvGrid content={CSV} path="d.csv" onChange={() => {}} />);
      fireEvent.doubleClick(screen.getByText('apples'));
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      expect(document.activeElement).toBe(gridOf(container));
    });

    it('Enter on the last row commits and gives focus back to the grid', () => {
      const onChange = vi.fn();
      const { container } = render(<CsvGrid content={CSV} path="d.csv" onChange={onChange} />);
      fireEvent.doubleClick(screen.getByText('pears'));
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'plums' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('name,qty\napples,3\nplums,5\n');
      expect(document.activeElement).toBe(gridOf(container));
    });

    it('Enter on a focused row scrolled out of the rendered window opens its editor', () => {
      const big = 'a,b\n' + Array.from({ length: 300 }, (_, i) => `v${i},${i}`).join('\n') + '\n';
      const { container } = render(<CsvGrid content={big} path="d.csv" onChange={() => {}} />);
      const grid = gridOf(container);
      fireEvent.mouseDown(screen.getByText('v4'));             // doc row 5
      fireEvent.scroll(grid, { target: { scrollTop: 5000 } });  // row 5 leaves the window
      expect(screen.queryByText('v4')).toBeNull();

      fireEvent.keyDown(grid, { key: 'Enter' });
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('v4');
    });

    it('Enter in the editor advances into a row below the rendered window', () => {
      const big = 'a,b\n' + Array.from({ length: 300 }, (_, i) => `v${i},${i}`).join('\n') + '\n';
      render(<CsvGrid content={big} path="d.csv" onChange={() => {}} />);
      expect(screen.queryByText('v20')).toBeNull();           // doc row 21: past the first window
      fireEvent.doubleClick(screen.getByText('v19'));          // doc row 20: the last one rendered
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('v20');
    });

    it('keys from the Delete row button are not taken over by the grid', () => {
      render(<CsvGrid content={CSV} path="d.csv" onChange={() => {}} />);
      fireEvent.mouseDown(screen.getByText('apples'));
      const del = screen.getAllByTitle('Delete row')[0];
      const notPrevented = fireEvent.keyDown(del, { key: 'Enter' });
      expect(notPrevented).toBe(true);
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('drops a selection the doc no longer covers', () => {
      const { rerender } = render(<CsvGrid content={CSV} path="d.csv" onChange={() => {}} />);
      fireEvent.mouseDown(screen.getByText('pears'));
      expect(screen.getByText(/row 2/)).toBeInTheDocument();

      rerender(<CsvGrid content={'name,qty\napples,3\n'} path="d.csv" onChange={() => {}} />);
      expect(screen.queryByText(/Ctrl\+C copies/)).toBeNull();
    });

    it('ArrowDown in an empty file never selects row -1', () => {
      const { container } = render(<CsvGrid content="" path="d.csv" onChange={() => {}} />);
      fireEvent.mouseDown(container.querySelector('thead th:nth-child(2)')!);
      fireEvent.keyDown(gridOf(container), { key: 'ArrowDown' });
      expect(screen.queryByText(/row -1/)).toBeNull();
    });

    it('after a copy, focus returns to the grid if the clipboard fallback took it', async () => {
      // copyText's insecure-context fallback focuses an off-screen textarea, then removes it.
      copyTextMock.mockImplementation(async () => {
        const ta = document.createElement('textarea');
        document.body.appendChild(ta);
        ta.focus();
        ta.remove();
      });
      const { container } = render(<CsvGrid content={CSV} path="d.csv" onChange={() => {}} />);
      fireEvent.mouseDown(screen.getByText('apples'));
      await act(async () => { fireEvent.keyDown(gridOf(container), { key: 'c', ctrlKey: true }); });
      expect(document.activeElement).toBe(gridOf(container));
    });
  });
});
