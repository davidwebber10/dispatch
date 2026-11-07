// Coach prompts (coach spec sections 4.1, 4.4, 5; plan Task 9): the text of each model call. The
// fixed instructions come first, in the system text, the same for every call of a step, so the
// provider's prompt cache can reuse them. What the Coach knows (confirmed facts, known skills,
// level adjustments, types turned off, goals) goes into every call: the memory is how advice
// improves without training. Answers are JSON.
import { normalizeMemory, typeLabel } from './memory.mjs';

const RULES = [
  'You are the Coach inside Dispatch, an app where people work with AI agents in threads.',
  'The people are developers and business users (operations, sales, finance, managers). Business users get no technical words.',
  'You help one person improve how they work with AI, one small step at a time, on five measures:',
  'ambition (how big a task they give AI), delegation (how much the AI does between their messages, threads in parallel),',
  'reuse (templates, skills, schedules for repeated work), judgment (a plan first, checking the result, pushing back),',
  'breadth (how many kinds of work they use AI for).',
  'Card rules: a headline of at most 8 words that starts with a verb; one "why" sentence that names the specific thing the person did;',
  'one action. Plain words, US spelling. Never write "should". Never grade the person. No jargon for business users.',
  'Every "think bigger" card also says how to check the result.',
  'Use what the Coach knows about the person: never suggest a skill they already have, or a kind of tip they turned off.',
  'When the rule saw "Repeated workflows" (plugin-fit), the card suggests building a Dispatch plugin for that workflow:',
  'also answer "plugin" (one line: what the plugin would do) and "parts" (a list of: view, button, worker, hook),',
  'and let the why line say why a plugin beats a template or a schedule here. The action is made for you; leave it out.',
].join('\n');

const ACTION_SHAPE = '"action": {"kind": "compose" | "schedule" | "threads", "label": "the button, at most 6 words, e.g. Try it: ask for a plan", "text": "for compose: the prompt to put in the message box", "prompt": "for schedule: the prompt to run", "cron": "for schedule: min hour dom mon dow", "prompts": ["for threads: one prompt per thread"]}';

export const CONFIRM_SYSTEM = `${RULES}\n\nTask: a rule noticed something in the person's recent work. Decide whether a card fits, how sure you are, and write the card.\nAnswer only with JSON: {"fit": true | false, "confidence": 0 to 1, "headline": "...", "why": "...", ${ACTION_SHAPE}}`;
export const WRITE_SYSTEM = `${RULES}\n\nTask: a smaller model confirmed this card. Write it as well as you can for this person, with the same facts.\nAnswer only with JSON: {"fit": true, "confidence": 0 to 1, "headline": "...", "why": "...", ${ACTION_SHAPE}}`;
export const MORE_SYSTEM = `${RULES}\n\nTask: the person clicked More on a card. Give a better version of what they wrote, and 2 to 4 short lines: why it helps, and what to check.\nAnswer only with JSON: {"better": "the better prompt", "bullets": ["..."]}`;
export const RECAP_SYSTEM = `${RULES}\n\nTask: write the weekly recap from the facts given. Keep each line short. Do not invent numbers.\nAnswer only with JSON: {"patterns": ["three lines, each an observed pattern"], "stretch": {"headline": "...", "why": "..."}, "learned": "one line on what the Coach learned"}`;

const MEASURE_WORD = { ambition: 'task size', delegation: 'handing off work', reuse: 'reuse', judgment: 'checking', breadth: 'new kinds of work' };

/** What the Coach knows, as lines for the model. Unconfirmed facts are left out. */
export function memoryContext(memory) {
  const m = normalizeMemory(memory);
  const lines = [];
  for (const f of m.facts) if (f.confirmedAt) lines.push(`- Fact: ${f.text}`);
  for (const k of m.known) lines.push(`- Already does: ${typeLabel(k)}`);
  for (const [measure, n] of Object.entries(m.levelAdjust)) if (n) lines.push(`- Tips on ${MEASURE_WORD[measure] || measure}: ${n > 0 ? 'aim higher' : 'start simpler'} (${n > 0 ? '+' : ''}${n})`);
  for (const x of m.muted) lines.push(`- Turned off: ${typeLabel(x.type)}`);
  for (const g of Array.isArray(m.goals) ? m.goals : []) if (g.status === 'active') lines.push(`- Goal: ${g.text}`);
  return lines.length ? `What the Coach knows about this person:\n${lines.join('\n')}` : 'What the Coach knows about this person: nothing yet.';
}

function candidateText(c) {
  const ev = { ...(c.evidence || {}) };
  const excerpt = typeof ev.excerpt === 'string' ? ev.excerpt : '';
  delete ev.excerpt;
  return [
    `What the rule saw: ${typeLabel(c.type)} (measure: ${c.measure}, tip type: ${c.tip || 'prompt'}).`,
    `Details: ${JSON.stringify(ev)}`,
    excerpt ? `What they wrote (an excerpt): ${excerpt}` : null,
  ].filter(Boolean).join('\n');
}

const call = (system, user, memory, maxTokens) => ({ system, messages: [{ role: 'user', content: `${memoryContext(memory)}\n\n${user}` }], maxTokens });

const PART_WORD = { view: 'a screen', button: 'a button', worker: 'a worker', hook: 'a hook' };
export const PLUGIN_PARTS = Object.freeze(Object.keys(PART_WORD));
export const partWords = (parts) => (parts || []).map((p) => PART_WORD[p] || p).join(', ');
/** The known plugin parts in an answer, without repeats. */
export const cleanParts = (parts) => (Array.isArray(parts) ? [...new Set(parts.filter((p) => PLUGIN_PARTS.includes(p)))] : []);

/**
 * The first prompt of the thread "Try it" opens for a plugin-fit card (spec section 4.7): an agent
 * builds the plugin as a local folder, which starts disabled, so the person reviews it first.
 */
export function buildPluginPrompt(card) {
  return [
    'Build a Dispatch plugin for me. Follow docs/plugins.md in the Dispatch repository (the plugin guide).',
    `What it does: ${card.plugin}`,
    `Parts: ${partWords(card.parts) || 'whatever it needs'}.`,
    card.excerpt ? `It replaces a workflow I repeat, which starts with: "${card.excerpt}"` : null,
    'Make it a local plugin folder under ~/.dispatch/plugins/<id> with plugin.json and web.js, plus a worker or hooks only if the parts above name them.',
    'Ask for the fewest permissions it needs. Do not enable it: it starts disabled, and I will review it on the Plugins page before I turn it on.',
    'When you finish, tell me what you built, the permissions it asks for, and what I need to check.',
  ].filter(Boolean).join('\n');
}

/**
 * The skill draft (spec section 4.8): the large model writes a skill from the repeated text only.
 * Nothing else goes in: not the memory, not the tasks around the block, not other prompts.
 */
export const SKILL_SYSTEM = [
  'You turn instructions a person types into many AI threads into a skill: text every thread gets in its system prompt.',
  'Keep their meaning; do not add rules they did not give. Plain words, US spelling.',
  'Answer only with JSON: {"name": "2 to 5 words", "description": "one line: what the skill makes the agent do", "body": "the SKILL.md text in Markdown: a # title, then the instructions as short bullets"}',
].join('\n');
export const skillDraftPrompt = (candidate) => ({
  system: SKILL_SYSTEM,
  messages: [{ role: 'user', content: `The repeated instructions:\n\n${String((candidate.evidence && candidate.evidence.text) || '')}` }],
  maxTokens: 1200,
});
/** A whole skill draft from an answer, or null. */
export function cleanSkill(ans) {
  if (!ans || typeof ans !== 'object') return null;
  const name = typeof ans.name === 'string' ? ans.name.trim().split('\n')[0].slice(0, 60) : '';
  const description = typeof ans.description === 'string' ? ans.description.trim().slice(0, 300) : '';
  const body = typeof ans.body === 'string' ? ans.body.trim() : '';
  if (!name || !description || !body || body.length > 64 * 1024) return null;
  return { name, description, body };
}

export const confirmPrompt = (candidate, memory) => call(CONFIRM_SYSTEM, candidateText(candidate), memory, 500);
export const writePrompt = (candidate, memory, draft) => call(WRITE_SYSTEM, `${candidateText(candidate)}\n\nThe confirmed card: ${JSON.stringify({ headline: draft && draft.headline, why: draft && draft.why, action: draft && draft.action })}`, memory, 700);
export const morePrompt = (card, memory) => call(MORE_SYSTEM, `Tip: ${card.headline}\nWhy: ${card.why}\nWhat they wrote: ${card.excerpt || '(not kept)'}`, memory, 600);
export const recapPrompt = (draft, memory) => call(RECAP_SYSTEM, `The facts of the week: ${JSON.stringify(draft)}`, memory, 800);

/** The JSON object in a model's answer, or null (no object, a broken one, or an array). */
export function parseAnswer(text) {
  const m = /\{[\s\S]*\}/.exec(typeof text === 'string' ? text : '');
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

const ACTION_KINDS = new Set(['compose', 'schedule', 'threads']);
const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

/** The action, cleaned: a known kind with what that kind needs, or null. */
export function cleanAction(a) {
  if (!a || typeof a !== 'object' || !nonEmpty(a.label)) return null;
  const kind = ACTION_KINDS.has(a.kind) ? a.kind : 'compose';
  const label = a.label.trim().slice(0, 60);
  if (kind === 'schedule' && nonEmpty(a.prompt)) return { kind, label, prompt: a.prompt.trim(), ...(nonEmpty(a.cron) ? { cron: a.cron.trim() } : {}) };
  if (kind === 'threads' && Array.isArray(a.prompts) && a.prompts.filter(nonEmpty).length >= 2) return { kind, label, prompts: a.prompts.filter(nonEmpty).slice(0, 6).map((p) => p.trim()) };
  const text = nonEmpty(a.text) ? a.text : nonEmpty(a.prompt) ? a.prompt : null;
  return text ? { kind: 'compose', label, text: text.trim() } : null;
}

/**
 * Why a card answer may not show, or null when it may: 'malformed' (a part is missing), 'no-fit',
 * 'unsure' (confidence under the setting), 'copy' (the headline is over 8 words, or "should").
 */
export function checkCard(ans, minConfidence) {
  if (!ans || typeof ans !== 'object') return 'malformed';
  if (!nonEmpty(ans.headline) || !nonEmpty(ans.why) || !cleanAction(ans.action)) return ans.fit === false ? 'no-fit' : 'malformed';
  if (ans.fit !== true) return 'no-fit';
  const conf = typeof ans.confidence === 'number' ? ans.confidence : 0;
  if (conf < (typeof minConfidence === 'number' ? minConfidence : 0.7)) return 'unsure';
  if (words(ans.headline) > 8 || /\bshould\b/i.test(ans.headline) || /\bshould\b/i.test(ans.why)) return 'copy';
  return null;
}
