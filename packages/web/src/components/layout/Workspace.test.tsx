import { render, screen } from '@testing-library/react';
import { Workspace } from './Workspace';

test('renders the three panes and a resize separator', () => {
  const { container } = render(<Workspace sidebar={<div>SIDE</div>} main={<div>MAIN</div>} inspector={<div>INSPECT</div>} />);
  expect(screen.getByText('SIDE')).toBeInTheDocument();
  expect(screen.getByText('MAIN')).toBeInTheDocument();
  expect(screen.getByText('INSPECT')).toBeInTheDocument();
  expect(container.querySelector('[role="separator"]')).toBeTruthy();
});
