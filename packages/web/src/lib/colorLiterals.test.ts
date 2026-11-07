import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Color audit (themes, 2026-11-07): every color in the app comes from a token in theme.css
// (--color-*, --syntax-*, --term-*), so a theme can repaint all of it. A literal color in a
// component would stay the same in every theme, which on a light theme reads as a bug.
// Tints use color-mix() with a token. src/themes/ holds the palettes and is the one place
// literals belong. Each exception below is content, not chrome, and is marked in the file
// with a `literal color:` comment. The count is exact: a new literal in an allowed file fails too.
const ALLOW: Record<string, { count: number; why: string }> = {
  'theme.css': { count: 80, why: 'the token definitions themselves (:root, the Dispatch Dark defaults)' },
  'stores/settings.ts': { count: 11, why: 'the accent swatches the user picks from' },
  'components/settings/AppearanceSection.tsx': { count: 8, why: 'the rainbow wheel of the custom accent picker' },
  'components/common/HarnessStrip.tsx': { count: 1, why: "the Claude brand mark's own color" },
  'components/settings/AccessSection.tsx': { count: 1, why: 'a QR code needs a white quiet zone to scan' },
  'components/setup/SetupWizard.tsx': { count: 1, why: 'a QR code needs a white quiet zone to scan' },
  'components/tabs/BrowserTab.tsx': { count: 1, why: 'a web page in an iframe expects a white page behind it' },
  'components/viewer/FileViewer.tsx': { count: 1, why: "a user's HTML page in an iframe expects a white page behind it" },
  'lib/appIcon.ts': { count: 2, why: 'the PWA icon PNG drawn on a canvas from the accent' },
  'components/update/Fireworks.tsx': { count: 1, why: 'canvas celebration art' },
  'components/update/blaster/Blaster.tsx': { count: 17, why: 'the canvas game palette (the game is a dark scene in every theme)' },
};

const SRC = path.resolve(__dirname, '..');
const HEX = /(?<![\w&/])(?<!PR )#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
const NAMED = /(?:color|background(?:Color)?|fill|stroke|border(?:Color|Top|Bottom|Left|Right)?|outline)\s*[:=]\s*[{'"`]*\s*(?:1px solid\s+)?(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver)\b/gi;

/** Comments may name a color (they explain one); only code counts. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\\w])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'test' && e.name !== 'themes') walk(p, out); continue; }
    if (/\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

export function countLiterals(src: string): string[] {
  const code = stripComments(src);
  return [...code.matchAll(HEX), ...code.matchAll(FN), ...code.matchAll(NAMED)].map((m) => m[0]);
}

describe('color literals', () => {
  it('no source file outside src/themes sets a literal color, except the marked, allowed content', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100); // the walk really reads the app
    const offenders: string[] = [];
    const counts: Record<string, number> = {};
    for (const file of files) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      const hits = countLiterals(fs.readFileSync(file, 'utf8'));
      if (!hits.length) continue;
      counts[rel] = hits.length;
      if (!ALLOW[rel]) offenders.push(`${rel}: ${hits.join(' ')}`);
    }
    expect(offenders).toEqual([]);
    const wrongCounts = Object.entries(ALLOW)
      .filter(([rel, a]) => (counts[rel] ?? 0) !== a.count)
      .map(([rel, a]) => `${rel}: ${counts[rel] ?? 0} literals, allow-list says ${a.count} (${a.why})`);
    expect(wrongCounts).toEqual([]);
  });

  it('every allowed file says why at the literal', () => {
    for (const rel of Object.keys(ALLOW)) {
      if (rel === 'theme.css') continue;
      expect(fs.readFileSync(path.join(SRC, rel), 'utf8'), rel).toMatch(/literal color/i);
    }
  });

  it('the scanner sees what it should', () => {
    expect(countLiterals(`style={{ color: '#fff', background: 'rgba(0,0,0,.5)' }}`)).toHaveLength(2);
    expect(countLiterals(`fill="white"`)).toHaveLength(1);
    expect(countLiterals(`// the old #2C2C32 border\nconst a = 1; /* #fff */`)).toHaveLength(0);
    expect(countLiterals(`const s = 'PR #218 · +24'; const u = 'https://x.y/#abc';`)).toHaveLength(0);
    expect(countLiterals(`color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 20%, transparent)'`)).toHaveLength(0);
  });
});
