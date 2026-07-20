import { expect, test, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SortMenu } from './SortMenu';

const OPTIONS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['name', 'Name (A–Z)']] as const;
afterEach(() => cleanup());

function renderMenu(onChange = vi.fn()) {
  render(<SortMenu value="newest" options={OPTIONS} onChange={onChange} isMobile={false} buttonStyle={{ width: 16 }} />);
  return onChange;
}

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
