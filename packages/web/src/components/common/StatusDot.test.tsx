import { render } from '@testing-library/react';
import { StatusDot } from './StatusDot';

test('working dot uses the accent green', () => {
  const { container } = render(<StatusDot state="working" />);
  const dot = container.firstChild as HTMLElement;
  expect(dot.style.background).toContain('var(--color-accent)');
});

test('needs_input dot uses the status yellow and the glow animation', () => {
  const { container } = render(<StatusDot state="needs_input" />);
  const dot = container.firstChild as HTMLElement;
  expect(dot.style.background).toContain('var(--color-status-yellow)');
  expect(dot.style.animationName).toBe('dispatchGlow');
});
