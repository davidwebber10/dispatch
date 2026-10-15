import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Blaster, blasterActivity } from './Blaster';

beforeEach(() => { try { localStorage.clear(); } catch { /* */ } });

describe('Blaster', () => {
  it('shows a calm start screen until the first key or tap, and survives a canvas with no 2d context', () => {
    render(<Blaster getWall={() => null} paused={false} />);
    expect(screen.getByText(/Press any key or tap to play/)).toBeInTheDocument();
    expect(screen.queryByText('SCORE')).toBeNull();
  });

  it('a key press starts the game and shows the score, lives and best', () => {
    render(<Blaster getWall={() => null} paused={false} />);
    act(() => { fireEvent.keyDown(window, { key: 'ArrowRight' }); });
    expect(screen.queryByText(/Press any key or tap to play/)).toBeNull();
    expect(screen.getByText('SCORE')).toBeInTheDocument();
    expect(screen.getByLabelText(/3 lives/)).toBeInTheDocument();
    expect(screen.getByText('BEST')).toBeInTheDocument();
  });

  it('a tap starts the game too, and every input marks activity', () => {
    blasterActivity.last = 0;
    const { container } = render(<Blaster getWall={() => null} paused={false} />);
    act(() => { fireEvent.pointerDown(container.querySelector('canvas')!, { pointerType: 'touch', clientX: 50, clientY: 50 }); });
    expect(screen.getByText('SCORE')).toBeInTheDocument();
    expect(blasterActivity.last).toBeGreaterThan(0);
  });

  it('keys typed into a text box do not start the game', () => {
    render(<><input aria-label="box" /><Blaster getWall={() => null} paused={false} /></>);
    const box = screen.getByLabelText('box');
    box.focus();
    act(() => { fireEvent.keyDown(box, { key: 'a' }); });
    expect(screen.getByText(/Press any key or tap to play/)).toBeInTheDocument();
  });
});
