import { test, expect } from 'vitest';
import { isMacLike, primaryMod, modLabel } from './hostkeys';

test('mac-like detection from platform string', () => {
  expect(isMacLike('MacIntel')).toBe(true);
  expect(isMacLike('iPhone')).toBe(true);
  expect(isMacLike('Win32')).toBe(false);
  expect(isMacLike('Linux x86_64')).toBe(false);
});
test('primaryMod picks metaKey on mac, ctrlKey elsewhere', () => {
  expect(primaryMod({ metaKey: true, ctrlKey: false } as KeyboardEvent, 'MacIntel')).toBe(true);
  expect(primaryMod({ metaKey: false, ctrlKey: true } as KeyboardEvent, 'Win32')).toBe(true);
  expect(primaryMod({ metaKey: true, ctrlKey: false } as KeyboardEvent, 'Win32')).toBe(false);
});
test('modLabel renders the right prefix', () => {
  expect(modLabel('N', 'MacIntel')).toBe('⌘N');
  expect(modLabel('N', 'Win32')).toBe('Ctrl+N');
});
