import { render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';

test('renders the top bar brand and its children', () => {
  render(<AppShell><div>BODY</div></AppShell>);
  // "Dispatch" appears twice in the top bar: the product brand and the mode toggle.
  expect(screen.getAllByText('Dispatch').length).toBeGreaterThan(0);
  expect(screen.getByText('BODY')).toBeInTheDocument();
});
