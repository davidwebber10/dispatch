// Coach weekly recap (coach spec section 4.2, mockup part 5; plan Task 12): on Monday, only after 5
// active days of data. Three patterns the Coach saw, one stretch for the week with a one-click
// start, one line on what the Coach learned. Built from the signals alone (no invented numbers);
// the worker may let the large model reword it. Pure functions.
import { normalizeMemory, memoryItems } from './memory.mjs';
import { weakest } from './measures.mjs';

export const MIN_ACTIVE_DAYS = 5;
const DAY = 86400_000;
const WEEK = 7 * DAY;
const ms = (iso) => Date.parse(iso);
const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : Number(now));
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Local days, in the last `days`, on which the person sent a prompt. */
export function activeDays(state, now, days = 30) {
  const t = toMs(now);
  const set = new Set();
  for (const p of (state && state.prompts) || []) { const at = ms(p.at); if (at <= t && at >= t - days * DAY) set.add(dayOf(at)); }
  return set.size;
}

function maxParallel(turns) {
  let best = turns.length ? 1 : 0;
  for (const x of turns) {
    const at = ms(x.start);
    const n = new Set(turns.filter((y) => ms(y.start) <= at && ms(y.end) > at).map((y) => y.t)).size;
    if (n > best) best = n;
  }
  return best;
}

/** One stretch per measure: a headline (verb first, at most 8 words), a why line, a one-click action, a check. */
function stretchFor(measure, repeat) {
  switch (measure) {
    case 'reuse':
      return repeat
        ? { headline: 'Turn your repeated prompt into a schedule', why: `You sent the same prompt ${repeat.n} times this week.`, action: { kind: 'schedule', label: 'Set it up', prompt: repeat.ex, cron: '0 8 * * 1-5', },
          check: 'Stop it any time.' }
        : { headline: 'Save one prompt you use often', why: 'A saved prompt is one click next time.', action: { kind: 'compose', label: 'Try it', text: 'Turn the prompt I use most into a reusable template with blanks for what changes.' }, check: 'Check: read the template once before you save it.' };
    case 'delegation':
      return { headline: 'Run two threads at once this week', why: 'Your threads ran one at a time.', action: { kind: 'compose', label: 'Try it', text: 'Split this work into parts that can run in separate threads, and list them.' }, check: 'Check: read each thread\'s summary before you use it.' };
    case 'judgment':
      return { headline: 'Ask for a plan before big tasks', why: 'A plan lets you fix the approach before it runs.', action: { kind: 'compose', label: 'Try it', text: 'Before you start, write a short plan and wait for my OK.' }, check: 'Check: read the plan before you say go.' };
    case 'breadth':
      return { headline: 'Try it on a new kind of work', why: 'Most of your threads this month were one kind of work.', action: { kind: 'compose', label: 'Try it', text: 'Help me with a task I usually do by hand: ' }, check: 'Check: compare the result with how you do it today.' };
    default:
      return { headline: 'Give it a whole task, not one step', why: 'Most of your prompts this week were one step each.', action: { kind: 'compose', label: 'Try it', text: 'Here is the whole task. Do all of it, then list what you changed and what I need to check: ' }, check: 'Check: read the list of changes before you use it.' };
  }
}

/**
 * The recap for the week before `now`, or null before 5 active days. `measures` is a measures()
 * result (or null); `cards` the card history (unused today, kept for the goal block in Task 12b).
 */
export function buildRecap(state, { memory, measures, now }) {
  const t = toMs(now);
  if (activeDays(state, t) < MIN_ACTIVE_DAYS) return null;
  const from = t - WEEK;
  const prompts = (state.prompts || []).filter((p) => ms(p.at) >= from && ms(p.at) <= t);
  const turns = (state.turns || []).filter((x) => ms(x.end) >= from && ms(x.end) <= t);
  const threads = Object.values(state.threads || {}).filter((th) => ms(th.first) >= from && ms(th.first) <= t && th.prompts > 0);
  const stats = { threads: threads.length, days: activeDays(state, t, 7), parallel: maxParallel(turns) };

  const patterns = [];
  const work = prompts.filter((p) => !p.ok);
  const byHash = new Map();
  for (const p of work) { const g = byHash.get(p.h) || { n: 0, ex: '' }; g.n++; if (p.ex) g.ex = p.ex; byHash.set(p.h, g); }
  const top = [...byHash.values()].sort((a, b) => b.n - a.n)[0];
  const repeat = top && top.n >= 3 ? top : null;
  if (repeat) patterns.push(`You typed the same prompt ${repeat.n} times${repeat.ex ? `: "${repeat.ex.slice(0, 80)}"` : ''}.`);
  const longest = turns.reduce((m, x) => Math.max(m, x.ms), 0);
  if (longest >= 60_000) patterns.push(`Your longest hands-off run was ${plural(Math.round(longest / 60_000), 'minute', 'minutes')}.`);
  const big = work.filter((p) => p.len > 400 || p.parts >= 3);
  if (big.length) patterns.push(`${big.filter((p) => p.plan).length} of ${plural(big.length, 'big task', 'big tasks')} started with a plan.`);
  patterns.push(stats.parallel > 1 ? `You ran up to ${stats.parallel} threads at a time.` : 'You ran one thread at a time.');
  const kinds = {};
  for (const th of threads) if (th.kind !== 'other') kinds[th.kind] = (kinds[th.kind] || 0) + 1;
  const [kind, n] = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0] || [];
  if (kind) patterns.push(`Most of your threads were ${kind} work (${n} of ${threads.length}).`);
  const fast = prompts.filter((p) => p.ok && p.gap !== null && p.gap >= 0 && p.gap <= 10_000 && p.prev >= 2 * 60_000).length;
  if (fast) patterns.push(`You approved ${plural(fast, 'long answer', 'long answers')} within seconds.`);

  const mem = normalizeMemory(memory);
  const focus = (measures && weakest(measures, mem.levelAdjust)) || (repeat ? 'reuse' : 'ambition');
  const stretch = { measure: focus, ...stretchFor(focus, repeat) };

  const facts = mem.facts.filter((f) => f.confirmedAt).sort((a, b) => ms(b.confirmedAt) - ms(a.confirmedAt));
  let learned = null;
  if (facts.length) learned = `The Coach learned: "${facts[0].text.replace(/[.\s]+$/, '')}."`;
  else { const items = memoryItems(mem).filter((i) => i.at).sort((a, b) => ms(b.at) - ms(a.at)); if (items.length) learned = `The Coach learned: ${items[0].label}.`; }

  return { week: dayOf(t), stats, patterns: patterns.slice(0, 3), stretch, learned };
}
