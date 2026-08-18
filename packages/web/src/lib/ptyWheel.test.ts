import { expect, test } from 'vitest';
import {
  consumePageTicks, consumeWheelTicks, isAltBuffer, shouldPtyScroll,
  PAGE_DOWN, PAGE_UP, PAGE_STEP_PX, WHEEL_DOWN, WHEEL_UP,
} from './ptyWheel';

test('only the alternate buffer is a TUI that owns scrolling', () => {
  expect(isAltBuffer('alternate')).toBe(true);
  expect(isAltBuffer('normal')).toBe(false);
  expect(isAltBuffer(undefined)).toBe(false);
});

test('Grok always uses PTY scroll, even on the normal buffer', () => {
  expect(shouldPtyScroll('normal', 'grok')).toBe(true);
  expect(shouldPtyScroll('alternate', 'claude-code')).toBe(true);
  expect(shouldPtyScroll('normal', 'claude-code')).toBe(false);
  expect(shouldPtyScroll('normal', 'shell')).toBe(false);
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

test('a short swipe does not emit a PageUp; crossing the step does', () => {
  const first = consumePageTicks(0, -40, PAGE_STEP_PX);
  expect(first.seq).toBe('');
  expect(consumePageTicks(first.accPx, -50, PAGE_STEP_PX).seq).toBe(PAGE_UP);
});

test('finger-up emits PageDown once the step is crossed', () => {
  expect(consumePageTicks(0, PAGE_STEP_PX * 2, PAGE_STEP_PX).seq).toBe(PAGE_DOWN.repeat(2));
});
