import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// No "This thread is asking you" strip with an Answer button (owner, 2026-11-07: "get rid of those …
// never use those"). A thread's question stays where the thread put it (its own chat or terminal),
// and the Needs-you alerts already point at it.
const WEB = path.resolve(__dirname, '..');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\\w])\/\/.*$/gm, '$1');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'test') walk(p, out); continue; }
    if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('no ask strip', () => {
  it('no source renders the "This thread is asking you" strip or its Answer shortcut', () => {
    const offenders = walk(WEB).filter((f) => /ThreadAskBanner|thread-ask-banner|This thread is asking you/.test(stripComments(fs.readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => path.relative(WEB, f))).toEqual([]);
  });
});
