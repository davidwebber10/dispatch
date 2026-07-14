import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect } from 'vitest';
import { SortableList } from './SortableList';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('renders every item via renderItem', () => {
  render(<SortableList items={items} onReorder={() => {}} renderItem={(it) => <div>row-{it.id}</div>} />);
  expect(screen.getByText('row-a')).toBeInTheDocument();
  expect(screen.getByText('row-b')).toBeInTheDocument();
  expect(screen.getByText('row-c')).toBeInTheDocument();
});

test('renders items when disabled (no drag wiring)', () => {
  render(<SortableList items={items} disabled onReorder={() => {}} renderItem={(it) => <div>row-{it.id}</div>} />);
  expect(screen.getByText('row-a')).toBeInTheDocument();
  expect(screen.getByText('row-b')).toBeInTheDocument();
  expect(screen.getByText('row-c')).toBeInTheDocument();
});

// The keyboard sensor preventDefaults on activation — that's what swallows the
// character. fireEvent returns false when a handler called preventDefault.
function renderInteractive() {
  return render(
    <SortableList
      items={items}
      onReorder={() => {}}
      renderItem={(it) => (
        <div>
          <input placeholder={`name-${it.id}`} />
          <button>menu-{it.id}</button>
        </div>
      )}
    />,
  );
}

test('space typed in an editable child does not lift the row (rename input bug)', () => {
  const { getByPlaceholderText } = renderInteractive();
  const input = getByPlaceholderText('name-a');
  input.focus();
  const notPrevented = fireEvent.keyDown(input, { key: ' ', code: 'Space' });
  expect(notPrevented).toBe(true);
});

test('space on a focused child button clicks it instead of lifting the row', () => {
  const { getByText } = renderInteractive();
  const button = getByText('menu-a');
  button.focus();
  const notPrevented = fireEvent.keyDown(button, { key: ' ', code: 'Space' });
  expect(notPrevented).toBe(true);
});

test('space on the row itself still lifts it (keyboard reorder a11y preserved)', () => {
  const { container } = renderInteractive();
  const row = container.querySelector('[role="button"]') as HTMLElement;
  row.focus();
  const notPrevented = fireEvent.keyDown(row, { key: ' ', code: 'Space' });
  expect(notPrevented).toBe(false);
});
