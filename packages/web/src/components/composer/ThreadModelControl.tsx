import { api } from '../../api/client';
import { useTabs, findTerminal } from '../../stores/tabs';
import { ModelControl } from './ModelPicker';
import type { SlashHarness } from '../../lib/slash';

const HARNESS_TYPES = new Set(['claude-code', 'codex', 'grok', 'opencode']);

/** The thread's saved model and effort, and its harness, from the tab store. */
export function useThreadSettings(terminalId: string): { harness: SlashHarness | null; model: string | null; effort: string | null } {
  const tab = useTabs((s) => findTerminal(s.byProject, terminalId));
  const cfg = (tab?.config ?? {}) as Record<string, unknown>;
  return {
    harness: tab && HARNESS_TYPES.has(tab.type) ? (tab.type as SlashHarness) : null,
    model: typeof cfg.model === 'string' && cfg.model ? cfg.model : null,
    effort: typeof cfg.effort === 'string' && cfg.effort ? cfg.effort : null,
  };
}

/** Make the change and say when it takes hold. Throws the daemon's plain reason when it refuses. */
export async function applyThreadSettings(terminalId: string, change: { model?: string | null; effort?: string }): Promise<string> {
  const { applied } = await api.setThreadSettings(terminalId, change);
  if (applied === 'after-turn') return 'Saved. It applies when the current turn ends.';
  if (applied === 'next-start') return 'Saved. It applies when the thread next starts.';
  return 'Changed. Applies from the next turn.';
}

const NOT_YET = 'Model and effort changes for this agent are not available yet.';

/** The picker for a Pretty thread or an overseer: the model name in the status row under the composer. */
export function ThreadModelControl({ terminalId, liveModel, mobile }: { terminalId: string; liveModel?: string; mobile: boolean }) {
  const { harness, model, effort } = useThreadSettings(terminalId);
  if (!harness) return liveModel ? <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{liveModel}</span> : null;
  const live = harness === 'claude-code' || harness === 'codex';
  return (
    <ModelControl
      owner={`thread:${terminalId}`}
      harness={harness}
      model={model}
      effort={effort}
      liveModel={liveModel}
      disabledReason={live ? undefined : NOT_YET}
      mobile={mobile}
      onApply={(change) => applyThreadSettings(terminalId, change)}
    />
  );
}
