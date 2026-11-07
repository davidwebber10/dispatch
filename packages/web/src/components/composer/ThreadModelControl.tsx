import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useTabs, findTerminal } from '../../stores/tabs';
import { ModelControl } from './ModelPicker';
import { codexEffortsFor, type SlashHarness } from '../../lib/slash';

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
  const { applied, clearedEffort } = await api.setThreadSettings(terminalId, change);
  const dropped = clearedEffort ? ` Effort ${clearedEffort} is not available on this model, so it was cleared.` : '';
  if (applied === 'after-turn') return `Saved. It applies when the current turn ends.${dropped}`;
  if (applied === 'next-start') return `Saved. It applies when the thread next starts.${dropped}`;
  return `Changed. Applies from the next turn.${dropped}`;
}

// The efforts a Codex model takes differ by model. The daemon asks the running app-server; with none
// running (or an older daemon) the built-in table answers. Asked once per ten minutes.
let codexEfforts: { at: number; p: Promise<Record<string, string[]> | null> } | null = null;
function loadCodexEfforts(): Promise<Record<string, string[]> | null> {
  if (!codexEfforts || Date.now() - codexEfforts.at > 10 * 60_000) {
    codexEfforts = { at: Date.now(), p: Promise.resolve().then(() => api.codexModelEfforts()).then((r) => r.live).catch(() => null) };
  }
  return codexEfforts.p;
}
export function resetCodexEffortsCache(): void { codexEfforts = null; }

/** The efforts to offer for a thread: a Codex model's own list, else undefined (the harness's fixed list). */
export function useEffortLevels(harness: SlashHarness | null, model: string | null, liveModel?: string): readonly string[] | undefined {
  const [live, setLive] = useState<Record<string, string[]> | null>(null);
  useEffect(() => {
    if (harness !== 'codex') return;
    let on = true;
    void loadCodexEfforts().then((l) => { if (on) setLive(l); });
    return () => { on = false; };
  }, [harness]);
  return harness === 'codex' ? codexEffortsFor(model ?? liveModel, live) : undefined;
}

const NOT_YET = 'Model and effort changes for this agent are not available yet.';

/** The picker for a Pretty thread or an overseer: the model name in the status row under the composer. */
export function ThreadModelControl({ terminalId, liveModel, mobile }: { terminalId: string; liveModel?: string; mobile: boolean }) {
  const { harness, model, effort } = useThreadSettings(terminalId);
  const efforts = useEffortLevels(harness, model, liveModel);
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
      efforts={efforts}
      onApply={(change) => applyThreadSettings(terminalId, change)}
    />
  );
}
