import { expect, test } from 'vitest';
import { platform } from '../../src/platform/index.js';

test('selects the implementation matching process.platform', () => {
  expect(platform.id).toBe(process.platform); // 'darwin' in CI here, 'win32' on Windows CI
});
