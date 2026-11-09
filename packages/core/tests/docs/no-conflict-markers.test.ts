// W1-B: a merge left `||||||| 778d03a0` and its stale base text in docs/network-access.md. No document may hold a marker.
import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DOCS = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'docs');
/** The four git conflict lines: ours, the base (diff3), the divider (alone on its line) and theirs. */
const MARKER = /^(<{7}( |$)|\|{7}( |$)|={7}$|>{7}( |$))/;

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) markdownFiles(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

test('the marker pattern matches the four conflict lines and not ordinary text', () => {
  for (const line of ['<<<<<<< HEAD', '||||||| 778d03a0', '=======', '>>>>>>> branch', '<<<<<<<', '>>>>>>>']) expect(MARKER.test(line), line).toBe(true);
  for (const line of ['======= a heading rule with text', '========', ' =======', '<<<<<<', '|||||||| table', '| a | b |', '=====']) expect(MARKER.test(line), line).toBe(false);
});

test('no line in docs/**/*.md is a git conflict marker', () => {
  const files = markdownFiles(DOCS);
  expect(files.length).toBeGreaterThan(10);
  const found: string[] = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (MARKER.test(line)) found.push(`${path.relative(DOCS, file)}:${i + 1}: ${line.slice(0, 40)}`);
    });
  }
  expect(found).toEqual([]);
});
