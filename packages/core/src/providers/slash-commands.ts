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
      // /model works for all four harnesses (the chip switches Grok and OpenCode too); effort is Claude and Codex only for now.
      if (!live && d.name === 'effort') c.disabledReason = LATER;
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

export interface ModelChoice { value: string; label: string }

/** The models the New Thread modal offers for a harness (no "Default": a live switch needs a concrete model). */
export function catalogModelChoices(harness: SlashHarness): ModelChoice[] {
  const list = HARNESSES.find((h) => h.type === harness)?.models ?? [];
  return list.filter((m): m is { label: string; model: string } => !!m.model).map((m) => ({ value: m.model, label: m.label }));
}

/**
 * The model a typed `/model <arg>` names: an option's label or id (case-insensitive), or an error listing the
 * choices. The options are the chip's own list (web: modelOptionsFor; daemon: the catalog), so the menu, the
 * chip and the daemon cannot disagree about which models exist.
 */
export function resolveModelArg(options: readonly ModelChoice[], arg: string): { model: string } | { error: string } {
  const want = arg.trim().toLowerCase();
  const hit = options.find((o) => o.label.toLowerCase() === want || o.value.toLowerCase() === want);
  if (hit) return { model: hit.value };
  const choices = options.map((o) => o.value).join(', ');
  return { error: choices ? `Unknown model "${arg}". Choose one of: ${choices}.` : `Unknown model "${arg}".` };
}

/** `levels`: the efforts to match against when the host knows better than the fixed list (a Codex model's own). */
export function resolveEffortArg(harness: SlashHarness, arg: string, levels?: readonly string[]): { effort: string } | { error: string } {
  const allowed = levels ?? (harness === 'claude-code' || harness === 'codex' ? EFFORT_LEVELS[harness] : null);
  if (!allowed) return { error: LATER + '.' };
  const want = arg.trim().toLowerCase();
  if (allowed.includes(want)) return { effort: want };
  return { error: `Unknown effort "${arg}". Choose one of: ${allowed.join(', ')}.` };
}

/**
 * Check an effort for a harness. Returns an error text, or null when it is fine. Claude and Codex only in this phase.
 * `ctx.codexEfforts`: the efforts the thread's model takes (they differ by model); without it, any model's.
 */
export function validateEffort(
  harness: string,
  effort: unknown,
  ctx?: { codexEfforts?: readonly string[]; codexModel?: string },
): string | null {
  if (harness !== 'claude-code' && harness !== 'codex') return LATER + '.';
  if (typeof effort !== 'string' || !effort) return 'effort must be a level name.';
  const allowed = harness === 'codex' && ctx?.codexEfforts ? ctx.codexEfforts : EFFORT_LEVELS[harness];
  if (!allowed.includes(effort)) {
    const who = harness === 'codex' && ctx?.codexModel ? `${ctx.codexModel} does not take that effort. ` : 'Unknown effort level. ';
    return `${who}Choose one of: ${allowed.join(', ')}.`;
  }
  return null;
}
