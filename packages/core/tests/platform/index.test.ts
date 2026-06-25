import { expect, test } from 'vitest';
import { platform, selectPlatform } from '../../src/platform/index.js';

test('selects the implementation matching process.platform', () => {
  expect(platform.id).toBe(process.platform); // 'darwin' in CI here, 'win32' on Windows CI
});

test('selectPlatform("linux").id === "linux"', () => {
  expect(selectPlatform('linux').id).toBe('linux');
});

test('selectPlatform("darwin").id === "darwin"', () => {
  expect(selectPlatform('darwin').id).toBe('darwin');
});

test('selectPlatform("win32").id === "win32"', () => {
  expect(selectPlatform('win32').id).toBe('win32');
});

test('selectPlatform throws for unsupported platform', () => {
  expect(() => selectPlatform('aix' as NodeJS.Platform)).toThrow();
});
