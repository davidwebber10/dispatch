// Coach detectors (coach spec section 5, tier 1; plan Task 8): deterministic rules over the signals
// state that PROPOSE candidate cards. A rule never shows a card alone: the judge (plan Task 9)
// confirms and writes it. Every threshold is a setting under advanced.thresholds.
import { DEFAULT_THRESHOLDS } from './settings.mjs';
import { hashText } from './signals.mjs';

/** The v1 detectors: the measure each one works on, and its tip type (Settings → Coach → tip types). */
export const DETECTORS = Object.freeze({
  'repeated-prompt': { measure: 'reuse', tip: 'thinkBigger' },
  'serial-independent': { measure: 'delegation', tip: 'thinkBigger' },
  'idle-wait': { measure: 'delegation', tip: 'thinkBigger' },
  'step-by-step': { measure: 'ambition', tip: 'prompt' },
  'no-plan-big-task': { measure: 'judgment', tip: 'prompt' },
  'fast-approve': { measure: 'judgment', tip: 'prompt' },
  'narrow-breadth': { measure: 'breadth', tip: 'thinkBigger' },
  // Reuse's top step (spec section 4.7): a workflow that belongs in Dispatch as a plugin.
  'plugin-fit': { measure: 'reuse', tip: 'thinkBigger' },
});

const MIN = 60_000;
const DAY = 86400_000;
/** Point detectors (one prompt, one turn) look back this far: older moments are not "what you just did". */
const RECENT = DAY;
const ms = (iso) => Date.parse(iso);

function candidate(type, { id, terminalId = null, projectId = null, evidence = {} }) {
  const d = DETECTORS[type];
  return { id: `${type}:${id}`, type, measure: d.measure, tip: d.tip, terminalId, projectId, evidence };
}

function repeatedPrompt(s, th, now) {
  const from = now - th.days * DAY;
  const groups = new Map();
  for (const p of s.prompts) {
    const t = ms(p.at);
    if (t < from || t > now) continue;
    const g = groups.get(p.h) || [];
    g.push(p); groups.set(p.h, g);
  }
  const out = [];
  for (const [h, g] of groups) {
    if (g.length < th.count) continue;
    const latest = g[g.length - 1];
    out.push(candidate('repeated-prompt', { id: h, terminalId: latest.t, projectId: latest.p, evidence: { count: g.length, days: th.days, excerpt: latest.ex, threads: [...new Set(g.map((x) => x.t))] } }));
  }
  return out;
}

function serialIndependent(s, th, now) {
  const from = now - th.windowHours * 3600_000;
  const byProject = new Map();
  for (const [id, t] of Object.entries(s.threads)) {
    if (!t.end || s.open[id] || !t.p) continue;
    const start = ms(t.first); const end = ms(t.end);
    if (start < from || end > now) continue;
    const list = byProject.get(t.p) || [];
    list.push({ id, start, end }); byProject.set(t.p, list);
  }
  const out = [];
  for (const [project, list] of byProject) {
    list.sort((a, b) => a.start - b.start);
    // A run: each thread starts after every earlier one ended, and each is short. Any overlap or long thread starts over.
    let run = []; let lastEnd = -Infinity; let best = [];
    for (const x of list) {
      const short = x.end - x.start < th.maxMinutes * MIN;
      if (x.start >= lastEnd && short) run.push(x);
      else run = short ? [x] : [];
      lastEnd = Math.max(lastEnd, x.end);
      if (run.length >= best.length) best = run.slice();
    }
    if (best.length >= th.threads) out.push(candidate('serial-independent', { id: `${project}:${best[0].id}`, terminalId: best[best.length - 1].id, projectId: project, evidence: { threads: best.length, terminalIds: best.map((x) => x.id), minutes: Math.round((best[best.length - 1].end - best[0].start) / MIN) } }));
  }
  return out;
}

function idleWait(s, th, now) {
  const turns = s.turns.filter((x) => ms(x.end) <= now && ms(x.end) >= now - RECENT && x.ms >= th.minutes * MIN);
  for (let i = turns.length - 1; i >= 0; i--) {
    const x = turns[i];
    const a = ms(x.start); const b = ms(x.end);
    const otherRan = s.turns.some((y) => y.t !== x.t && ms(y.start) < b && ms(y.end) > a);
    const sentSomething = s.prompts.some((p) => { const t = ms(p.at); return t > a && t < b; });
    if (otherRan || sentSomething) continue;
    return [candidate('idle-wait', { id: `${x.t}:${x.end}`, terminalId: x.t, projectId: x.p, evidence: { minutes: Math.round(x.ms / MIN) } })];
  }
  return [];
}

function stepByStep(s, th, now) {
  const byThread = new Map();
  for (const p of s.prompts) {
    if (ms(p.at) > now || ms(p.at) < now - RECENT) continue;
    const list = byThread.get(p.t) || [];
    list.push(p); byThread.set(p.t, list);
  }
  const out = [];
  for (const [t, list] of byThread) {
    // A run of one-line prompts in a row; a longer prompt ends the run.
    let run = []; let found = null;
    for (const p of list) {
      const oneLine = p.lines <= 1 && p.len <= th.maxChars;
      if (!oneLine) { run = []; continue; }
      run.push(p);
      while (run.length && ms(p.at) - ms(run[0].at) > th.minutes * MIN) run.shift();
      if (run.length >= th.prompts) found = run.slice();
    }
    if (found) out.push(candidate('step-by-step', { id: `${t}:${found[0].at}`, terminalId: t, projectId: found[0].p, evidence: { prompts: found.length, minutes: Math.round((ms(found[found.length - 1].at) - ms(found[0].at)) / MIN), excerpt: found[found.length - 1].ex } }));
  }
  return out;
}

function noPlanBigTask(s, th, now) {
  const out = [];
  for (const p of s.prompts) {
    if (ms(p.at) > now || ms(p.at) < now - RECENT) continue;
    if (p.len > th.minChars && p.parts >= th.minParts && !p.plan) out.push(candidate('no-plan-big-task', { id: `${p.t}:${p.at}`, terminalId: p.t, projectId: p.p, evidence: { parts: p.parts, chars: p.len, excerpt: p.ex } }));
  }
  return out.slice(-1);
}

function fastApprove(s, th, now) {
  const out = [];
  for (const p of s.prompts) {
    if (ms(p.at) > now || ms(p.at) < now - RECENT) continue;
    if (p.ok && p.gap !== null && p.gap >= 0 && p.gap <= th.seconds * 1000 && p.prev >= th.longTurnMinutes * MIN) {
      out.push(candidate('fast-approve', { id: `${p.t}:${p.at}`, terminalId: p.t, projectId: p.p, evidence: { seconds: Math.round(p.gap / 1000), turnMinutes: Math.round(p.prev / MIN), excerpt: p.ex } }));
    }
  }
  return out.slice(-1);
}

function narrowBreadth(s, th, now) {
  const from = now - th.days * DAY;
  const kinds = {};
  let total = 0;
  for (const t of Object.values(s.threads)) {
    const at = ms(t.first);
    if (at < from || at > now || !t.prompts) continue;
    kinds[t.kind] = (kinds[t.kind] || 0) + 1; total++;
  }
  if (total < th.minThreads) return [];
  const [kind, n] = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0];
  if (kind === 'other' || n / total <= th.share) return [];
  const month = new Date(now).toISOString().slice(0, 7);
  return [candidate('narrow-breadth', { id: `${kind}:${month}`, evidence: { kind, threads: n, total, days: th.days } })];
}

/**
 * The same multi-step workflow (the same first `minSteps` work prompts, in order, in one thread)
 * `minRepeats` times in `days`, that no schedule covers: no thread a schedule started begins with
 * the workflow's first step.
 */
function pluginFit(s, th, now) {
  const from = now - th.days * DAY;
  const byThread = new Map();
  for (const p of s.prompts) {
    const t = ms(p.at);
    if (t < from || t > now || p.ok) continue;
    const list = byThread.get(p.t) || [];
    list.push(p); byThread.set(p.t, list);
  }
  const groups = new Map();
  for (const [t, list] of byThread) {
    if (list.length < th.minSteps) continue;
    const sig = list.slice(0, th.minSteps).map((p) => p.h).join('.');
    const g = groups.get(sig) || [];
    g.push({ t, list }); groups.set(sig, g);
  }
  const scheduled = new Set(Object.values(s.threads).map((x) => x.auto).filter(Boolean));
  const out = [];
  for (const [sig, g] of groups) {
    if (g.length < th.minRepeats) continue;
    if (scheduled.has(g[0].list[0].h)) continue;
    // The steps all runs share, in order.
    let steps = Math.min(...g.map((x) => x.list.length));
    while (steps > th.minSteps && !g.every((x) => x.list[steps - 1].h === g[0].list[steps - 1].h)) steps--;
    const latest = g.reduce((a, b) => (ms(b.list[0].at) > ms(a.list[0].at) ? b : a));
    const first = latest.list[0];
    out.push(candidate('plugin-fit', { id: hashText(sig), terminalId: latest.t, projectId: first.p, evidence: { steps, repeats: g.length, days: th.days, excerpt: first.ex, hashes: latest.list.slice(0, steps).map((p) => p.h) } }));
  }
  return out;
}

const RUN = {
  'repeated-prompt': (s, t, n) => repeatedPrompt(s, t.repeatedPrompt, n),
  'serial-independent': (s, t, n) => serialIndependent(s, t.serialIndependent, n),
  'idle-wait': (s, t, n) => idleWait(s, t.idleWait, n),
  'step-by-step': (s, t, n) => stepByStep(s, t.stepByStep, n),
  'no-plan-big-task': (s, t, n) => noPlanBigTask(s, t.noPlanBigTask, n),
  'fast-approve': (s, t, n) => fastApprove(s, t.fastApprove, n),
  'narrow-breadth': (s, t, n) => narrowBreadth(s, t.narrowBreadth, n),
  'plugin-fit': (s, t, n) => pluginFit(s, t.pluginFit, n),
};

/**
 * The candidates the state supports now. `ctx.weakest` is the weakest measure (plan Task 12): while it
 * is judgment, no bigger handoff is proposed (the gate, coach spec section 3).
 */
export function detect(state, settings, now, ctx = {}) {
  if (!state || !settings || settings.howOften === 'off') return [];
  const th = { ...DEFAULT_THRESHOLDS, ...((settings.advanced && settings.advanced.thresholds) || {}) };
  const t = now instanceof Date ? now.getTime() : Number(now);
  const leave = new Set(settings.leaveAlone || []);
  const tips = settings.tipTypes || {};
  const out = [];
  for (const type of Object.keys(DETECTORS)) {
    if (tips[DETECTORS[type].tip] === false) continue;
    for (const c of RUN[type](state, th, t)) {
      if (c.projectId && leave.has(c.projectId)) continue;
      if (ctx.weakest === 'judgment' && (c.measure === 'ambition' || c.measure === 'delegation')) continue;
      out.push(c);
    }
  }
  // A step of a workflow that is a plugin candidate is not also a repeated prompt: one card, not two.
  const inWorkflow = new Set(out.filter((c) => c.type === 'plugin-fit').flatMap((c) => c.evidence.hashes || []));
  return inWorkflow.size ? out.filter((c) => !(c.type === 'repeated-prompt' && inWorkflow.has(c.id.slice('repeated-prompt:'.length)))) : out;
}

const KEEP_CANDIDATES = 50;
const KEEP_SEEN = 500;

/**
 * The worker's `candidates` document after a detection: candidates not proposed before join the
 * list (newest last, capped), and their ids join `seen` so a situation is proposed once.
 */
export function proposeNew(doc, cands, now) {
  const items = Array.isArray(doc && doc.items) ? doc.items : [];
  const seen = Array.isArray(doc && doc.seen) ? doc.seen : [];
  const known = new Set(seen);
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const added = [];
  for (const c of cands) if (!known.has(c.id)) { known.add(c.id); added.push({ ...c, at }); }
  return { items: [...items, ...added].slice(-KEEP_CANDIDATES), seen: [...seen, ...added.map((c) => c.id)].slice(-KEEP_SEEN), added };
}
