// The right panel toggle shows the open decision count while the pane is collapsed (pinned card
// spec 2026-10-08, Unit 7), so the decisions are not out of sight.
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { PanelToggle } from './PanelToggle';
import { useUI } from '../../stores/ui';

afterEach(cleanup);

describe('PanelToggle — the open decision count', () => {
  it('shows the count on the collapsed right toggle', () => {
    useUI.setState({ rightCollapsed: true });
    render(<PanelToggle side="right" count={3} />);
    expect(screen.getByTestId('panel-toggle-count')).toHaveTextContent('3');
    expect(screen.getByRole('button')).toHaveAccessibleName('Show details panel (3 open decisions)');
  });

  it('no count while the pane is open, or when nothing is open', () => {
    useUI.setState({ rightCollapsed: false });
    const { unmount } = render(<PanelToggle side="right" count={3} />);
    expect(screen.queryByTestId('panel-toggle-count')).not.toBeInTheDocument();
    unmount();
    useUI.setState({ rightCollapsed: true });
    render(<PanelToggle side="right" count={0} />);
    expect(screen.queryByTestId('panel-toggle-count')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAccessibleName('Show details panel');
  });
});
