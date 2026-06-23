import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderScreen } from '../../src/status/screen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures/prompts', name), 'utf8');

describe('renderScreen', () => {
  it('restores absolute-column spacing (CHA) that naive stripping would collapse', async () => {
    // 'a' at col 1, then cursor to col 5, then 'b' -> "a" + 3 spaces + "b"
    expect(await renderScreen('a\x1b[5Gb')).toBe('a   b');
  });

  it('renders a captured Claude prompt with correct spacing', async () => {
    const screen = await renderScreen(fx('claude-trust-folder.txt'));
    expect(screen).toContain('Quick safety check');
    expect(screen).toContain('1. Yes, I trust this folder');
  });

  it('returns only the current viewport, not the whole scrollback', async () => {
    const raw = Array.from({ length: 120 }, (_, i) => `scroll-line-${i}`).join('\r\n');
    const screen = await renderScreen(raw);
    expect(screen.split('\n').length).toBeLessThanOrEqual(40);
    expect(screen).not.toContain('scroll-line-0');   // old scrollback excluded
    expect(screen).toContain('scroll-line-119');      // latest visible line kept
  });
});
