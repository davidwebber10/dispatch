import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageToolsNote } from './image-tools.js';

it('one line that names the tools list when the image has it; nothing otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-tools-'));
  const file = path.join(dir, 'tools.json');
  expect(imageToolsNote(file)).toBe('');
  fs.writeFileSync(file, '{"tools":[]}');
  expect(imageToolsNote(path.join(dir, 'other.json'))).toBe('');
  const fresh = path.join(dir, 'tools2.json');
  fs.writeFileSync(fresh, '{"tools":[]}');
  const line = imageToolsNote(fresh);
  expect(line).toContain(fresh);
  expect(line.split('\n')).toHaveLength(1);
  fs.rmSync(dir, { recursive: true, force: true });
});
