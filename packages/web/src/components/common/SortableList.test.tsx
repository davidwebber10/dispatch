import { render, screen, fireEvent, act } from '@testing-library/react';
import { test, expect, vi, beforeAll } from 'vitest';
import { createPortal } from 'react-dom';
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

// jsdom has no PointerEvent; dnd-kit's pointer activator checks isPrimary /
// button on the native event, so back it with a MouseEvent that carries them.
beforeAll(() => {
  if (!window.PointerEvent) {
    class PointerEventShim extends MouseEvent {
      isPrimary: boolean;
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.isPrimary = init.isPrimary ?? true;
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (window as unknown as { PointerEvent: typeof PointerEventShim }).PointerEvent = PointerEventShim;
  }
});

// The pointer sensor hears pointerdown via React-tree bubbling, which crosses
// portals: modals rendered by a row's card (rename, new-thread) live under
// document.body in the DOM but still bubble into the row's drag listeners.
// A press-hold on the new-thread <select> (the native picker swallows the
// pointerup) therefore lifted the project row and left it wiggling.
function renderWithPortaledModal() {
  return render(
    <SortableList
      items={items}
      onReorder={() => {}}
      renderItem={(it) => (
        <div>
          <span>body-{it.id}</span>
          {createPortal(
            <select aria-label={`kind-${it.id}`}><option>Claude Code</option></select>,
            document.body,
          )}
        </div>
      )}
    />,
  );
}

function holdPointer(el: Element) {
  fireEvent.pointerDown(el, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
  act(() => { vi.advanceTimersByTime(250); });
}

test('press-hold inside a portaled modal does not lift the row (new-thread select bug)', () => {
  vi.useFakeTimers();
  try {
    const { getByLabelText } = renderWithPortaledModal();
    holdPointer(getByLabelText('kind-a'));
    expect(document.querySelector('.dispatch-wiggle')).toBeNull();
  } finally { vi.useRealTimers(); }
});

test('press-hold on row content still lifts the row', () => {
  vi.useFakeTimers();
  try {
    const { getByText } = renderWithPortaledModal();
    holdPointer(getByText('body-a'));
    expect(document.querySelector('.dispatch-wiggle')).not.toBeNull();
  } finally { vi.useRealTimers(); }
});
