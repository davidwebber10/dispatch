import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm run lint` (repository root) is a gate for later waves. These checks keep the gate honest:
 * the warning ceiling stays in package.json, and the promise rules stay errors.
 * The config is read as text: to import it would load the whole of typescript-eslint in a unit test.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..', '..', '..');

describe('lint gate', () => {
  test('the root lint script covers core and cli and holds a warning ceiling', () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
    expect(scripts.lint).toMatch(/^eslint packages\/core\/src packages\/cli\/src --max-warnings \d+$/);
    expect(scripts.typecheck).toBe('pnpm -C packages/core run typecheck');
  });

  test('the promise rules are errors and an empty catch is a warning', () => {
    const cfg = fs.readFileSync(path.join(ROOT, 'eslint.config.js'), 'utf8');
    expect(cfg).toMatch(/'@typescript-eslint\/no-floating-promises': 'error'/);
    expect(cfg).toMatch(/'@typescript-eslint\/no-misused-promises': \['error'/);
    expect(cfg).toMatch(/'no-empty': \['warn', \{ allowEmptyCatch: false \}\]/);
  });
});
