/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';

// Border-radius audit (2026-11-05): every radius in the app comes from the scale in theme.css
// (--radius-xs … --radius-pill), circles excepted. This keeps a new literal from creeping back.
const sources = import.meta.glob(['../**/*.tsx', '!../**/*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const RADIUS = /(?:borderRadius|border(?:Top|Bottom)(?:Left|Right)Radius):\s*([^,}\n]+)/g;

describe('radius scale', () => {
  it('no component sets a literal border radius: only scale tokens, 0, 50% or a token-valued expression', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100); // the glob really reads the app
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(RADIUS)) {
        const v = m[1].trim();
        if (/\b(?:[1-9]\d*(?:\.\d+)?)(?:px)?\b/.test(v.replace(/var\(--radius-[\w]+\)/g, '').replace(/50%/g, '')) && !/^[A-Za-z_]\w*(\.\w+)?$/.test(v)) offenders.push(`${file}: ${v}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
