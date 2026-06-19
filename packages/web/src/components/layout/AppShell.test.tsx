import { render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';

test('renders the top bar brand and its children', () => {
  render(<AppShell><div>BODY</div></AppShell>);
  expect(screen.getByText('Dispatch')).toBeInTheDocument();
  expect(screen.getByText('BODY')).toBeInTheDocument();
});
