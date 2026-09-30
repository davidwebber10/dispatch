import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { isMainModule } from '../src/index.js';

// The CLI runs main() only when node was started on this module. Node resolves symlinks
// for import.meta.url but leaves process.argv[1] as typed, so a plain string compare fails
// whenever the checkout sits behind a symlink — macOS `/tmp` → `/private/tmp`, or a
// symlinked projects folder — and every `dispatch <cmd>` silently exits 0 doing nothing.
describe('isMainModule', () => {
  let root: string;
  let realFile: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-entry-')));
    fs.mkdirSync(path.join(root, 'real', 'dist'), { recursive: true });
    realFile = path.join(root, 'real', 'dist', 'index.js');
    fs.writeFileSync(realFile, '');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('true when argv[1] is the module path itself', () => {
    expect(isMainModule(realFile, pathToFileURL(realFile).href)).toBe(true);
  });

  test('true when argv[1] reaches the module through a symlinked directory', () => {
    const viaLink = path.join(root, 'link', 'dist', 'index.js');
    expect(isMainModule(viaLink, pathToFileURL(realFile).href)).toBe(true);
  });

  test('false for a different file (imported by a test runner or another script)', () => {
    const other = path.join(root, 'real', 'dist', 'other.js');
    fs.writeFileSync(other, '');
    expect(isMainModule(other, pathToFileURL(realFile).href)).toBe(false);
  });

  test('false, not a throw, when argv[1] is missing or does not exist', () => {
    expect(isMainModule(undefined, pathToFileURL(realFile).href)).toBe(false);
    expect(isMainModule(path.join(root, 'nope.js'), pathToFileURL(realFile).href)).toBe(false);
  });
});
