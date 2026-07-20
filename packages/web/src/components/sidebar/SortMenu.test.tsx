import { expect, test, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SortMenu, SORT_GLYPH, SORT_GLYPH_FONT } from './SortMenu';

const OPTIONS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name (A–Z)']] as const;
afterEach(() => cleanup());

function renderMenu(onChange = vi.fn()) {
  render(<SortMenu value="newest" options={OPTIONS} onChange={onChange} isMobile={false} buttonStyle={{ width: 16 }} />);
  return onChange;
}

test('draws the shared glyph in the shared font, not the host button\'s font', () => {
  // The host passes the `+` button's style, whose `font` shorthand sets family,
  // weight and size at once. If it wins, this control stops matching the projects
  // sorter in ProjectSidebar and reads as a different icon — the bug this guards.
  render(<SortMenu value="newest" options={OPTIONS} onChange={vi.fn()} isMobile
    buttonStyle={{ width: 34, height: 34, font: '500 26px/1 var(--font-sans)' }} />);
  const btn = screen.getByLabelText('Sort');
  expect(btn.textContent).toBe(SORT_GLYPH);
  // Compare through the CSSOM rather than against the literal: it re-serializes
  // the shorthand (`14px/1` -> `14px / 1`), so a raw string match tests the
  // serializer, not the style.
  const probe = document.createElement('span');
  probe.style.font = SORT_GLYPH_FONT;
  expect(btn.style.font).toBe(probe.style.font);
  expect(btn.style.fontSize).toBe('14px');       // not the host's 26px
  expect(btn.style.fontWeight).toBe('400');      // not the host's 500/600
  // ...while the box, and so the touch target, still comes from the host.
  expect(btn.style.width).toBe('34px');
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
