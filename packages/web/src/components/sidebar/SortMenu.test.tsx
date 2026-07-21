import { expect, test, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SortMenu } from './SortMenu';

const OPTIONS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name (A–Z)']] as const;
afterEach(() => cleanup());

function renderMenu(onChange = vi.fn()) {
  render(<SortMenu value="newest" options={OPTIONS} onChange={onChange} isMobile={false} buttonStyle={{ width: 16 }} />);
  return onChange;
}

test('renders the ArrowsDownUp Phosphor icon (same family as the + Plus), sized to match', () => {
  // Consolidated with the `+` button onto one icon family: the sort control is now a Phosphor
  // icon, not a text glyph, so it and the `+` (Plus) are stylistically identical. The host
  // passes iconSize matching its own `+` icon; the box still comes from buttonStyle.
  render(<SortMenu value="newest" options={OPTIONS} onChange={vi.fn()} isMobile
    buttonStyle={{ width: 34, height: 34 }} iconSize={18} />);
  const btn = screen.getByLabelText('Sort');
  const svg = btn.querySelector('svg');
  expect(svg).not.toBeNull();                 // an icon, not a text glyph
  expect(svg?.getAttribute('width')).toBe('18'); // matches the host's + icon size
  expect(btn.style.width).toBe('34px');       // box + touch target still from the host
});

test('falls back to a per-breakpoint icon size when the host passes none', () => {
  render(<SortMenu value="newest" options={OPTIONS} onChange={vi.fn()} isMobile={false} buttonStyle={{ width: 16 }} />);
  expect(screen.getByLabelText('Sort').querySelector('svg')?.getAttribute('width')).toBe('14');
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
