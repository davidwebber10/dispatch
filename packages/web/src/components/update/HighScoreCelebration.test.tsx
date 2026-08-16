import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { HighScoreCelebration } from './HighScoreCelebration';
import { recordBest } from './popScore';

// The post-restart popup: mounts in the normal view, claims the localStorage
// celebration flag exactly once, renders the score, and is dismissable.
describe('HighScoreCelebration', () => {
  beforeEach(() => localStorage.clear());

  it('renders nothing when no celebration is pending', () => {
    const { container } = render(<HighScoreCelebration />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the score and the beaten previous best, then closes on the button', () => {
    recordBest(87, 60);
    render(<HighScoreCelebration />);
    expect(screen.getByText('New high score!')).toBeInTheDocument();
    expect(screen.getByText('87')).toBeInTheDocument();
    expect(screen.getByText(/old best of 60/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Nice'));
    expect(screen.queryByText('New high score!')).toBeNull();
  });

  it('first-ever score gets first-score copy (no "old best of 0")', () => {
    recordBest(12, 0);
    render(<HighScoreCelebration />);
    expect(screen.getByText(/first update-rain high score/)).toBeInTheDocument();
    expect(screen.queryByText(/old best of/)).toBeNull();
  });

  it('claims the flag on mount: a second mount does not celebrate again', () => {
    recordBest(87, 60);
    const first = render(<HighScoreCelebration />);
    expect(screen.getByText('New high score!')).toBeInTheDocument();
    first.unmount();
    render(<HighScoreCelebration />);
    expect(screen.queryByText('New high score!')).toBeNull();
  });
});
