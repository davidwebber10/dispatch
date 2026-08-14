import { render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';

test('renders the icon rail navigation and its children', () => {
  render(<AppShell><div>BODY</div></AppShell>);
  expect(screen.getByRole('button', { name: 'Threads' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Analytics' })).toBeInTheDocument();
  expect(screen.getByText('BODY')).toBeInTheDocument();
});

test('the active view is marked with aria-pressed', () => {
  render(<AppShell><div /></AppShell>);
  const pressed = screen.getAllByRole('button', { pressed: true });
  expect(pressed.length).toBe(1);
});
