import { expect, test } from 'vitest';
import { platform, selectPlatform } from '../../src/platform/index.js';

test('selects the implementation matching process.platform', () => {
  expect(platform.id).toBe(process.platform); // 'darwin' or 'linux' in CI here
});

test('selectPlatform("linux").id === "linux"', () => {
  expect(selectPlatform('linux').id).toBe('linux');
});

test('selectPlatform("darwin").id === "darwin"', () => {
  expect(selectPlatform('darwin').id).toBe('darwin');
});

test('selectPlatform("win32") throws (WSL2-only; win32 is not a supported target)', () => {
  expect(() => selectPlatform('win32' as NodeJS.Platform)).toThrow();
});

test('selectPlatform throws for unsupported platform', () => {
  expect(() => selectPlatform('aix' as NodeJS.Platform)).toThrow();
});
