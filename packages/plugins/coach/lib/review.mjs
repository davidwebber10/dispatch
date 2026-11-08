// Reviews: "look at how I worked" (coach spec section 4.10; plan Task 12f). The person asks for a
// review of a thread, a project or a date range; the worker reads the transcripts in chunks with
// the large model and returns findings, each tied to a quoted moment, and 1-3 next steps. A cost
// estimate comes first; nothing runs until Start. The look back at history is a range review over
// the last 30 days that also seeds the signals. Pure helpers; the engine runs the job.
import { normalizeMemory } from './memory.mjs';
import { normalize, hashText } from './signals.mjs';

/** One model call reads at most this much transcript. */
export const CHUNK_CHARS = 12_000;
/** A chunk's estimated share of the weekly limit, in percent (the large model, ~3k tokens in, ~600 out). An estimate. */
export const PERCENT_PER_CHUNK = 0.05;
/** With the cost unknown, the smaller scope offered first: the newest threads up to this many chunks. */
export const UNKNOWN_SCOPE_CHUNKS = 8;
/** A review reads at most this many threads (the newest). */
export const MAX_THREADS = 40;
const ITEM_CHARS = 800;
export const FINDING_KINDS = Object.freeze(['went-well', 'handoff', 'plan', 'check', 'reuse', 'parallel']);
const STEP_KINDS = new Set(['add-goal', 'create-skill', 'schedule', 'build-plugin', 'new-threads']);

/** A transcript (the conversation route's items) as text, cut into chunks of at most `max` characters. */
export function chunkTranscript(items, max = CHUNK_CHARS) {
  const lines = [];
  for (const it of items || []) {
    if (!it || typeof it !== 'object') continue;
    const t = typeof it.text === 'string' ? it.text.trim().slice(0, ITEM_CHARS) : '';
    if (it.kind === 'user' && t) lines.push(`${it.source === 'coordinator' ? 'Coordinator' : 'Person'}: ${t}`);
    else if (it.kind === 'assistant' && t) lines.push(`Agent: ${t}`);
    else if (it.kind === 'tool') lines.push(`Agent used a tool: ${it.toolName || it.toolTitle || 'tool'}`);
  }
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > max) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const pct = (b) => (b && typeof b.usedPercent === 'number' && typeof b.capPercent === 'number' ? b : null);

/**
 * The estimate before a review starts. `threads`: [{ id, chunks }] newest first (the threads in the
 * scope, with the chunks their transcripts make). `fits`: the estimate stays under the budget cap.
 * Over the cap, `smallerScope` names the newest threads that fit (or is absent when none does).
 * With no percent figure (no budget heard, or no usage data for the account), the cost is
 * unknown: `costUnknown`, `fits: null` (never true), and a smaller scope first when there is one.
 */
export function planReview(scope, threads, budget) {
  const list = (threads || []).slice(0, MAX_THREADS);
  const chunks = list.reduce((n, t) => n + Math.max(0, t.chunks || 0), 0);
  const estPercent = Math.round(chunks * PERCENT_PER_CHUNK * 100) / 100;
  // Each thread's part count: the progress corrects the total when a thread reads differently.
  const parts = Object.fromEntries(list.map((t) => [t.id, Math.max(0, t.chunks || 0)]));
  const b = pct(budget);
  if (!b) {
    const out = { scope, threads: list.map((t) => t.id), chunks, parts, estPercent, fits: null, costUnknown: true };
    if (chunks > UNKNOWN_SCOPE_CHUNKS) {
      let n = 0; let used = 0;
      while (n < list.length && used + (list[n].chunks || 0) <= UNKNOWN_SCOPE_CHUNKS) { used += list[n].chunks || 0; n++; }
      if (n > 0) out.smallerScope = { kind: 'thread', ids: list.slice(0, n).map((t) => t.id) };
    }
    return out;
  }
  const room = b.capPercent - b.usedPercent;
  const fits = estPercent <= room;
  const out = { scope, threads: list.map((t) => t.id), chunks, parts, estPercent, fits };
  if (!fits) {
    let n = 0; let used = 0;
    while (n < list.length && used + (list[n].chunks || 0) * PERCENT_PER_CHUNK <= room) { used += (list[n].chunks || 0) * PERCENT_PER_CHUNK; n++; }
    if (n > 0) out.smallerScope = { kind: 'thread', ids: list.slice(0, n).map((t) => t.id) };
  }
  return out;
}

export const REVIEW_SYSTEM = [
  'You are the Coach inside Dispatch. You review a part of a conversation between a person and an AI agent, to help the person work better with AI.',
  'Look for: what went well; where the person could have handed off more (a whole task, not one step); planned first; checked the result; reused something (a template, a skill, a schedule); or run things in parallel.',
  'Every finding quotes the transcript word for word (a short quote from a line), and says in one plain sentence what to do differently. Do not invent anything that is not in the transcript. Few findings are fine.',
  'Plain words, US spelling, never "should". Then 0 to 3 next steps the person can take.',
  `Answer only with JSON: {"findings": [{"kind": ${FINDING_KINDS.map((k) => `"${k}"`).join(' | ')}, "quote": "...", "note": "..."}], "nextSteps": [{"text": "...", "action": optional {"kind": "add-goal" | "create-skill" | "schedule" | "build-plugin" | "new-threads", "payload": {...}}}]}`,
].join('\n');

/** One review call: a chunk of transcript, with the person's goals and what the Coach knows. */
export function reviewPrompt(chunk, memory, goals) {
  const m = normalizeMemory(memory);
  const ctx = [];
  for (const g of goals || m.goals.filter((x) => x.status === 'active')) ctx.push(`- Goal: ${g.text}`);
  for (const f of m.facts) if (f.confirmedAt) ctx.push(`- Fact: ${f.text}`);
  return {
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: `${ctx.length ? `What the Coach knows about the person:\n${ctx.join('\n')}\n\n` : ''}The transcript part:\n${chunk}` }],
    maxTokens: 1200,
  };
}

/** The findings and next steps in an answer. A finding whose quote is not in the chunk is dropped (no invented moments). */
export function parseReview(text, chunk) {
  const m = /\{[\s\S]*\}/.exec(typeof text === 'string' ? text : '');
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const hay = normalize(chunk);
  const findings = (Array.isArray(j.findings) ? j.findings : []).filter((f) => f && FINDING_KINDS.includes(f.kind) && typeof f.quote === 'string' && typeof f.note === 'string' && f.quote.trim() && f.note.trim() && hay.includes(normalize(f.quote)))
    .map((f) => ({ kind: f.kind, quote: f.quote.trim().slice(0, 300), note: f.note.trim().slice(0, 300) }));
  const nextSteps = (Array.isArray(j.nextSteps) ? j.nextSteps : []).filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s) => ({ text: s.text.trim().slice(0, 200), ...(s.action && STEP_KINDS.has(s.action.kind) && s.action.payload && typeof s.action.payload === 'object' ? { action: { kind: s.action.kind, payload: s.action.payload } } : {}) }));
  return { findings, nextSteps };
}

/** The report from every chunk's answer: findings without repeats (at most 12), at most 3 next steps. */
export function mergeReview(parts, meta = {}) {
  const seen = new Set();
  const findings = [];
  const nextSteps = [];
  for (const p of parts) {
    for (const f of p.findings || []) { const k = hashText(f.quote); if (!seen.has(k)) { seen.add(k); findings.push(f); } }
    for (const s of p.nextSteps || []) if (!nextSteps.some((x) => x.text === s.text)) nextSteps.push(s);
  }
  const read = meta.read || 0;
  const summary = read === 0
    ? 'The Coach found no transcript it could read in this scope, so it has no findings. Threads in a shell, or without a saved transcript, cannot be read.'
    : findings.length === 0
      ? `The Coach read ${read} ${read === 1 ? 'thread' : 'threads'} and found nothing it could tie to a quoted moment. That is an honest result, not a gap.`
      : `The Coach read ${read} ${read === 1 ? 'thread' : 'threads'}. Each finding quotes the moment it is about.`;
  return { summary, findings: findings.slice(0, 12), nextSteps: nextSteps.slice(0, 3) };
}

/**
 * The look back at history: thread:* events from a transcript (items with times), so the signals
 * and the measures start from real work. A prompt's turn ends at the last agent item before the
 * next prompt.
 */
export function eventsFromTranscript(terminalId, sessionId, items) {
  const out = [];
  let open = null;
  let lastAgent = null;
  const flush = () => { if (open && lastAgent && Date.parse(lastAgent) >= Date.parse(open)) out.push({ type: 'thread:turn', terminalId, sessionId, at: lastAgent, ms: Date.parse(lastAgent) - Date.parse(open) }); };
  for (const it of items || []) {
    if (!it || typeof it.ts !== 'string' || !Number.isFinite(Date.parse(it.ts))) continue;
    if (it.kind === 'user' && typeof it.text === 'string' && it.text.trim()) {
      flush();
      out.push({ type: 'thread:prompt', terminalId, sessionId, at: it.ts, source: it.source === 'coordinator' ? 'coordinator' : 'user', text: it.text });
      open = it.ts; lastAgent = null;
    } else if (it.kind === 'tool') {
      out.push({ type: 'thread:tool', terminalId, sessionId, at: it.ts, tool: it.toolName || 'tool' });
      lastAgent = it.ts;
    } else if (it.kind === 'assistant' || it.kind === 'tool-result') lastAgent = it.ts;
  }
  flush();
  return out;
}
