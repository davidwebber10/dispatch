// The "/" command registry for Pretty threads, overseers and Chat. Pure and import-light on
// purpose: the web imports it too (like catalog.ts), so the menu and the daemon's checks cannot drift.
import { HARNESSES } from './catalog.js';
import { CODEX_ALL_EFFORTS } from './codex-efforts.js';

export type SlashSurface = 'thread' | 'overseer' | 'chat';
export type SlashHarness = 'claude-code' | 'codex' | 'grok' | 'opencode';

export interface SlashCommand {
  name: string;
  description: string;
  takesArgs: boolean;
  /** Set when the command is listed but cannot run here; the menu greys it and shows this. */
  disabledReason?: string;
}

interface Def { name: string; description: string; takesArgs: boolean; surfaces: SlashSurface[] }

const DEFS: Def[] = [
  { name: 'model', description: 'Change the model', takesArgs: true, surfaces: ['thread', 'overseer', 'chat'] },
  { name: 'effort', description: 'Change the effort level', takesArgs: true, surfaces: ['thread', 'overseer', 'chat'] },
  { name: 'compact', description: 'Summarize the conversation to free context', takesArgs: false, surfaces: ['thread', 'overseer'] },
  { name: 'stop', description: 'Stop the current turn', takesArgs: false, surfaces: ['thread', 'overseer', 'chat'] },
  { name: 'cli', description: 'Switch this thread to the CLI', takesArgs: false, surfaces: ['thread'] },
  { name: 'restart', description: 'Restart this thread', takesArgs: false, surfaces: ['thread'] },
];
const KNOWN = new Set(DEFS.map((d) => d.name));

/** The effort levels each harness offers. Claude's list is `CLAUDE_EFFORT_LEVELS` (sessions/cc-sessions.ts). */
export const EFFORT_LEVELS: Record<'claude-code' | 'codex', readonly string[]> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  // Every effort any Codex model takes. Which of them a given model takes is codexEffortsFor (codex-efforts.ts).
  codex: CODEX_ALL_EFFORTS,
};

const LATER = 'Not yet available for this agent';

/** The commands a composer lists, in menu order. A command the harness cannot run is kept, with a reason. */
export function slashCommandsFor(surface: SlashSurface, harness: SlashHarness): SlashCommand[] {
  const live = harness === 'claude-code' || harness === 'codex';
  return DEFS.filter((d) => d.surfaces.includes(surface))
    .filter((d) => !(d.name === 'cli' && !live)) // Grok and OpenCode have no CLI mode to switch to
    .map((d) => {
      const c: SlashCommand = { name: d.name, description: d.description, takesArgs: d.takesArgs };
      if (!live && (d.name === 'model' || d.name === 'effort')) c.disabledReason = LATER;
      if (!live && d.name === 'compact') c.disabledReason = 'This agent has no compact';
      return c;
    });
}

export interface ParsedSlash { name: string; args: string; known: boolean }

/**
 * A message that starts with `/word`, or null. No leading space: that is the escape that sends a
 * literal `/model` as text (verified: Claude passes ` /effort high` to the model). A path such as
 * `/usr/bin` is not a word (the slash is followed by more path), so it is null too.
 */
export function parseSlash(text: string): ParsedSlash | null {
  const m = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return { name, args: (m[2] ?? '').trim(), known: KNOWN.has(name) };
}

function catalogModels(harness: SlashHarness): { label: string; model: string | null }[] {
  const type = harness === 'claude-code' ? 'claude-code' : harness;
  return HARNESSES.find((h) => h.type === type)?.models ?? [];
}

/** The model a typed `/model <arg>` names: a catalog label or id (case-insensitive), or an error listing the choices. */
export function resolveModelArg(harness: SlashHarness, arg: string): { model: string | null } | { error: string } {
  const want = arg.trim().toLowerCase();
  const list = catalogModels(harness);
  const hit = list.find((m) => m.label.toLowerCase() === want || (m.model ?? 'default') === want);
  if (hit) return { model: hit.model };
  const choices = list.map((m) => m.model ?? 'default').join(', ');
  return { error: `Unknown model "${arg}". Choose one of: ${choices}.` };
}

export function resolveEffortArg(harness: SlashHarness, arg: string): { effort: string } | { error: string } {
  const levels = harness === 'claude-code' || harness === 'codex' ? EFFORT_LEVELS[harness] : null;
  if (!levels) return { error: LATER + '.' };
  const want = arg.trim().toLowerCase();
  if (levels.includes(want)) return { effort: want };
  return { error: `Unknown effort "${arg}". Choose one of: ${levels.join(', ')}.` };
}

// Same rules as overseer/spawn-model.ts, repeated here so the web bundle does not pull the overseer code in.
const CLAUDE_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable']);
const isClaudeTierAlias = (m: string) => CLAUDE_ALIASES.has(m);
const nonClaudeModelHarness = (m: string) => /^(gpt-|o\d|grok-)/.test(m.trim().toLowerCase());

const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/;

/**
 * Check a model/effort change for a harness. Returns an error text, or null when it is fine.
 * `model: null` resets a Claude thread to the default; Codex cannot unset a thread's model.
 */
export function validateThreadSettings(
  harness: string,
  change: { model?: string | null; effort?: string },
  /** Codex: the efforts the thread's model (after this change) takes. Default: all that any model takes. */
  ctx?: { codexEfforts?: readonly string[]; codexModel?: string },
): string | null {
  if (harness !== 'claude-code' && harness !== 'codex') return LATER + '.';
  if (change.model === undefined && change.effort === undefined) return 'Send a model or an effort to change.';
  if (change.model !== undefined) {
    const m = change.model;
    if (m === null) {
      if (harness === 'codex') return 'A Codex thread cannot go back to the default model: pick a model.';
    } else if (typeof m !== 'string' || !MODEL_SHAPE.test(m)) {
      return 'That is not a valid model name.';
    } else if (harness === 'claude-code') {
      if (nonClaudeModelHarness(m)) return 'That model does not run on Claude Code. Pick a Claude model.';
    } else if (isClaudeTierAlias(m) || m.toLowerCase().startsWith('claude-')) {
      return 'That model does not run on Codex. Pick a Codex model.';
    }
  }
  if (change.effort !== undefined) {
    const allowed = harness === 'codex' && ctx?.codexEfforts ? ctx.codexEfforts : EFFORT_LEVELS[harness];
    if (!allowed.includes(change.effort as string)) {
      const who = harness === 'codex' && ctx?.codexModel ? `${ctx.codexModel} does not take that effort. ` : 'Unknown effort level. ';
      return `${who}Choose one of: ${allowed.join(', ')}.`;
    }
  }
  return null;
}
