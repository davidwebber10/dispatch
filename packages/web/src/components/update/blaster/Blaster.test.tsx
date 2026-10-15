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
  it('the controls are keys only: the hint says so, and a mouse click only starts the round', () => {
    const { container } = render(<Blaster getWall={() => null} paused={false} />);
    expect(screen.getByText(/Up thrusts · Left\/Right turn · Down brakes/)).toBeInTheDocument();
    expect(screen.queryByText(/mouse/i)).toBeNull();
    act(() => { fireEvent.pointerDown(container.querySelector('canvas')!, { pointerType: 'mouse', clientX: 50, clientY: 50 }); });
    expect(screen.getByText('SCORE')).toBeInTheDocument();
    expect((container.querySelector('canvas') as HTMLCanvasElement).style.cursor).toBe('default');
  });
  it('a running round shows the loadout bar: each weapon with its key, and the A-bomb count', () => {
    render(<Blaster getWall={() => null} paused={false} />);
    act(() => { fireEvent.keyDown(window, { key: 'ArrowUp' }); });
    const bar = screen.getByRole('list', { name: 'Loadout' });
    for (const [key, name] of [['Space', 'Blaster'], ['Q', 'Missile'], ['E', 'Heat-seeker'], ['R', 'Mortar'], ['F', 'A-bomb']]) {
      expect(bar.textContent).toContain(key);
      expect(bar.textContent).toContain(name);
    }
    expect(screen.getByLabelText('A-bombs: 1')).toBeInTheDocument();
  });

  it('on a phone, the four extra weapons have buttons', () => {
    const { container } = render(<Blaster getWall={() => null} paused={false} />);
    const canvas = container.querySelector('canvas')!;
    act(() => { fireEvent.touchStart(canvas); fireEvent.pointerDown(canvas, { pointerType: 'touch', clientX: 50, clientY: 50 }); });
    for (const name of ['Missile', 'Heat-seeker', 'Mortar', 'A-bomb']) expect(screen.getByRole('button', { name: `Fire ${name}` })).toBeInTheDocument();
  });
});
