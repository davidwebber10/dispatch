import { expect, test, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SortMenu, SORT_GLYPH } from './SortMenu';

const OPTIONS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name (A–Z)']] as const;
afterEach(() => cleanup());

function renderMenu(onChange = vi.fn()) {
  render(<SortMenu value="newest" options={OPTIONS} onChange={onChange} isMobile={false} buttonStyle={{ width: 16 }} />);
  return onChange;
}

test('mobile: glyph matches the + button\'s weight, controls its size, keeps Arial\'s shape', () => {
  // The fix: match the neighbouring + button's WEIGHT (thickness) — the old fixed 400 read
  // thinner — and set a controlled size that lines up with the 26px + rather than inheriting
  // the host font wholesale (which was thin AND, on mobile, tiny at 14px). Family stays Arial
  // for its cleaner U+21C5 shape, NOT the host's var(--font-sans).
  render(<SortMenu value="newest" options={OPTIONS} onChange={vi.fn()} isMobile
    buttonStyle={{ width: 34, height: 34, font: '500 26px/1 var(--font-sans)' }} />);
  const btn = screen.getByLabelText('Sort');
  expect(btn.textContent).toBe(SORT_GLYPH);
  expect(btn.style.fontFamily.toLowerCase()).toContain('arial'); // Arial shape, not var(--font-sans)
  expect(btn.style.fontFamily).not.toContain('font-sans');
  expect(btn.style.fontWeight).toBe('500');      // matches the +'s weight — same thickness
  expect(btn.style.fontSize).toBe('22px');       // controlled — not the host's 26px, not the old 14px
  // ...while the box, and so the touch target, still comes from the host.
  expect(btn.style.width).toBe('34px');
});

test('desktop: glyph matches the desktop +\'s 600/14px', () => {
  render(<SortMenu value="newest" options={OPTIONS} onChange={vi.fn()} isMobile={false}
    buttonStyle={{ width: 16, height: 16, font: '600 14px/1 var(--font-sans)' }} />);
  const btn = screen.getByLabelText('Sort');
  expect(btn.style.fontWeight).toBe('600');
  expect(btn.style.fontSize).toBe('14px');
  expect(btn.style.fontFamily.toLowerCase()).toContain('arial');
});

test('renders only the trigger until it is clicked', () => {
  renderMenu();
  expect(screen.getByLabelText('Sort')).toBeInTheDocument();
  expect(screen.queryByText('Newest')).toBeNull();
});

test('opens the menu showing every option', () => {
  renderMenu();
  fireEvent.click(screen.getByLabelText('Sort'));
  for (const [, label] of OPTIONS) expect(screen.getByText(new RegExp(label.replace(/[()]/g, '\\$&')))).toBeInTheDocument();
});

test('choosing an option reports it and closes the menu', () => {
  const onChange = renderMenu();
  fireEvent.click(screen.getByLabelText('Sort'));
  fireEvent.click(screen.getByText(/Oldest/));
  expect(onChange).toHaveBeenCalledWith('oldest');
  expect(screen.queryByText(/Oldest/)).toBeNull();
});

test('Escape closes without choosing', () => {
  const onChange = renderMenu();
  fireEvent.click(screen.getByLabelText('Sort'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByText(/Oldest/)).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

test('clicking the backdrop closes without choosing', () => {
  const onChange = renderMenu();
  fireEvent.click(screen.getByLabelText('Sort'));
  fireEvent.click(screen.getByTestId('sort-menu-backdrop'));
  expect(screen.queryByText(/Oldest/)).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

test('the menu escapes the card by rendering into document.body', () => {
  const { container } = render(
    <div style={{ overflow: 'hidden' }}>
      <SortMenu value="newest" options={OPTIONS} onChange={() => {}} isMobile={false} buttonStyle={{}} />
    </div>
  );
  fireEvent.click(screen.getByLabelText('Sort'));
  // the panel must NOT be inside the clipping parent
  expect(container.querySelector('[data-testid="sort-menu-panel"]')).toBeNull();
  expect(document.body.querySelector('[data-testid="sort-menu-panel"]')).not.toBeNull();
});
