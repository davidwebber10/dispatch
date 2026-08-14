import { expect, test } from 'vitest';
import { consumeWheelTicks, isAltBuffer, WHEEL_DOWN, WHEEL_UP } from './ptyWheel';

test('only the alternate buffer is a TUI that owns scrolling', () => {
  expect(isAltBuffer('alternate')).toBe(true);
  expect(isAltBuffer('normal')).toBe(false);
  expect(isAltBuffer(undefined)).toBe(false);
});

test('finger-down (negative px) emits wheel-up ticks once a row is crossed', () => {
  const first = consumeWheelTicks(0, -10, 17);
  expect(first.seq).toBe('');
  const second = consumeWheelTicks(first.accPx, -10, 17);
  expect(second.seq).toBe(WHEEL_UP);
});

test('finger-up (positive px) emits wheel-down ticks', () => {
  expect(consumeWheelTicks(0, 34, 17).seq).toBe(WHEEL_DOWN.repeat(2));
});
