import type { AgentType } from './agent-types.js';

export interface Harness {
  /** The picker's own id. */
  id: 'claude' | 'codex' | 'grok' | 'opencode' | 'terminal';
  label: string;
  /** The wire `type` sent to POST /terminals. */
  type: AgentType | 'shell';
  /** Which detected CLI backs it, or null for the plain shell (always available). */
  provider: 'claude' | 'codex' | 'grok' | 'opencode' | null;
  /**
   * The modes this harness can run, in display order. `cli` is the raw terminal (PTY),
   * `pretty` the structured chat transport. Grok is pretty-only: its TUI never rendered
   * well in Dispatch (mobile paging, alt-screen churn), so the PTY option is gone for new
   * Grok threads — existing PTY threads keep working.
   */
  modes: ReadonlyArray<'cli' | 'pretty'>;
  /**
   * The mode a NEW thread starts on when the user saved no per-harness preference.
   * Claude defaults to `pretty`: the CLI (PTY) view can only ever show what the TUI
   * leaves in a bounded byte replay — respawns reduce history to a resume stub and a
   * width change rewraps it into noise — so long turns are only reliably readable on
   * the structured chat. Absent ⇒ the first listed mode.
   */
  defaultMode?: 'cli' | 'pretty';
  /** Models offered for it. `null` means "let the CLI choose". */
  models: { label: string; model: string | null }[];
}

/** The mode a new thread of this harness starts on absent a saved preference. */
export function defaultModeFor(h: Harness): 'cli' | 'pretty' {
  return h.defaultMode ?? h.modes[0];
}

export const HARNESSES: Harness[] = [
  {
    id: 'claude', label: 'Claude Code', type: 'claude-code', provider: 'claude', modes: ['cli', 'pretty'], defaultMode: 'pretty',
    models: [
      { label: 'Default', model: null },
      { label: 'Fable', model: 'fable' },
      { label: 'Opus', model: 'opus' },
      { label: 'Sonnet', model: 'sonnet' },
      { label: 'Haiku', model: 'haiku' },
    ],
  },
  {
    id: 'codex', label: 'Codex', type: 'codex', provider: 'codex', modes: ['cli', 'pretty'],
    models: [
      { label: 'Default', model: null },
      // The models Codex's own model/list offers (2026-11-12; providers/codex-efforts.ts has their efforts).
      { label: 'GPT-6 Astra', model: 'gpt-6-astra' },
      { label: 'GPT-6.1 Sol', model: 'gpt-6.1-sol' },
      { label: 'GPT-6.1 Terra', model: 'gpt-6.1-terra' },
      { label: 'GPT-6 Luna', model: 'gpt-6-luna' },
    ],
  },
  {
    // Pretty-ONLY since the ACP transport landed (grok agent stdio → GrokStructuredSessionManager).
    id: 'grok', label: 'Grok', type: 'grok', provider: 'grok', modes: ['pretty'],
    models: [
      { label: 'Default', model: null },
      { label: 'Grok 4.5', model: 'grok-4.5' },
    ],
  },
  {
    // Pretty-ONLY, like Grok, and the only harness with no bundled model: it runs
    // models through OpenRouter (`opencode acp`, same ACP transport as Grok) under
    // the user's OpenCode/OpenRouter credential. Its model list is NOT here: it is a
    // per-user setting (Settings → Agents → OpenCode) seeded from the daemon's
    // curated defaults, and arrives as `opencodeModels` on GET /api/settings/harnesses.
    id: 'opencode', label: 'OpenCode', type: 'opencode', provider: 'opencode', modes: ['pretty'],
    models: [],
  },
  { id: 'terminal', label: 'Terminal', type: 'shell', provider: null, modes: ['cli'], models: [] },
];

/**
 * The plain name of a model id, for a message a person reads: the catalog label when the id is listed
 * ("GPT-6.1 Terra"), else a GPT id spelled the same way (gpt-6.2-sol → "GPT-6.2 Sol"), else the id.
 */
export function modelLabel(model: string): string {
  for (const h of HARNESSES) {
    const hit = h.models.find((m) => m.model === model);
    if (hit) return hit.label;
  }
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(model);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')}` : ''}`;
  return model;
}

/** What a person reads when the account's provider refuses a model: plain, with what to do next. */
export function refusedModelMessage(model: string): string {
  return `This account cannot use ${modelLabel(model)}. Pick another model.`;
}
