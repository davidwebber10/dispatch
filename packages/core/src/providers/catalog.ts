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
      { label: '6 Astra', model: 'gpt-6-astra' },
      { label: '5.6 Sol', model: 'gpt-5.6-sol' },
      { label: '5.6 Terra', model: 'gpt-5.6-terra' },
      { label: '5.6 Luna', model: 'gpt-5.6-luna' },
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
    // per-user setting (Settings → Harnesses → OpenCode) seeded from the daemon's
    // curated defaults, and arrives as `opencodeModels` on GET /api/settings/harnesses.
    id: 'opencode', label: 'OpenCode', type: 'opencode', provider: 'opencode', modes: ['pretty'],
    models: [],
  },
  { id: 'terminal', label: 'Terminal', type: 'shell', provider: null, modes: ['cli'], models: [] },
];
