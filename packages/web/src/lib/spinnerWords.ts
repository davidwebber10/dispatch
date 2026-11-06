// The words shown while an agent works (2026-11-06). Claude Code calls them spinner verbs
// ("Flibbertigibbeting…"); Dispatch sets them for Claude's CLI threads (core harness settings) and
// uses the same list for its own "Working…" indicator in Pretty threads, Control Plane and Chat.
import type { SpinnerVerbs } from '../api/types';

/** The word Dispatch shows when no words are chosen, and alongside "add to Claude's" words. */
export const DEFAULT_WORD = 'Working';

/** Ready-made sets offered in Settings. Any list can be typed instead. */
export const WORD_SETS: readonly { name: string; words: readonly string[] }[] = [
  { name: 'Plain', words: ['Working', 'Thinking', 'Reading', 'Writing', 'Checking', 'Building', 'Testing', 'Fixing'] },
  { name: 'Dispatch', words: ['Dispatching', 'Routing', 'Relaying', 'Coordinating', 'Patching through', 'Copying that', 'Rolling', 'On it'] },
  { name: 'Workshop', words: ['Tinkering', 'Wrenching', 'Soldering', 'Sanding', 'Measuring twice', 'Tightening bolts', 'Calibrating', 'Hammering'] },
  { name: 'Kitchen', words: ['Cooking', 'Simmering', 'Prepping', 'Seasoning', 'Whisking', 'Plating', 'Tasting', 'Reducing'] },
  { name: 'POLYWOOD', words: ['Recycling milk jugs', 'Building Adirondacks', 'Milling lumber', 'Weatherproofing', 'Assembling', 'Stacking chairs', 'Setting the patio', 'Rocking on the porch', 'Lounging', 'Built to last'] },
  { name: 'Space', words: ['Launching', 'Orbiting', 'Docking', 'Charting', 'Calculating trajectory', 'Firing thrusters', 'Scanning', 'Warping'] },
];

/** The words the indicator picks from: only the chosen ones, or them plus the default. */
export function wordPool(v: SpinnerVerbs | null | undefined): string[] {
  if (!v?.verbs.length) return [DEFAULT_WORD];
  return v.mode === 'replace' ? v.verbs : [DEFAULT_WORD, ...v.verbs];
}

/** One word from the pool. `rand` is injectable for tests. */
export function pickWord(v: SpinnerVerbs | null | undefined, rand: () => number = Math.random): string {
  const pool = wordPool(v);
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

/** A typed list → words: split on commas or new lines, trimmed, trailing dots dropped, no repeats. */
export function parseWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const w = raw.trim().replace(/(\.|…)+$/, '').trim();
    if (!w || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
  }
  return out;
}
