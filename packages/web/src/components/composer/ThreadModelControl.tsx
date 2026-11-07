import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useTabs, findTerminal } from '../../stores/tabs';
import { ModelControl } from './ModelPicker';
import { codexDefaultEffortFor, codexEffortsFor, type SlashHarness } from '../../lib/slash';

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
  const { applied, clearedEffort, effortNow } = await api.setThreadSettings(terminalId, change);
  const dropped = clearedEffort
    ? ` Effort ${clearedEffort} is not available on this model, so it now runs at ${effortNow ?? 'the model\'s default'}.`
    : effortNow ? ` Effort is now ${effortNow}, this model's default.` : '';
  if (applied === 'after-turn') return `Saved. It applies when the current turn ends.${dropped}`;
  if (applied === 'next-start') return `Saved. It applies when the thread next starts.${dropped}`;
  return `Changed. Applies from the next turn.${dropped}`;
}

// The efforts a Codex model takes, and the one it runs at by default, differ by model. The daemon asks the running
// app-server; with none running (or an older daemon) the built-in table answers. Asked once per ten minutes.
type CodexInfo = { live: Record<string, string[]> | null; defaults: Record<string, string> | null };
let codexInfo: { at: number; p: Promise<CodexInfo> } | null = null;
function loadCodexInfo(): Promise<CodexInfo> {
  if (!codexInfo || Date.now() - codexInfo.at > 10 * 60_000) {
    codexInfo = { at: Date.now(), p: Promise.resolve().then(() => api.codexModelEfforts()).then((r) => ({ live: r.live, defaults: r.defaults ?? null })).catch(() => ({ live: null, defaults: null })) };
  }
  return codexInfo.p;
}
export function resetCodexEffortsCache(): void { codexInfo = null; }

/** For a Codex thread: the efforts its model takes and the one it runs at when none is saved. Undefined for other harnesses. */
export function useCodexModelInfo(harness: SlashHarness | null, model: string | null, liveModel?: string): { levels: readonly string[]; defaultEffort: string } | undefined {
  const [info, setInfo] = useState<CodexInfo>({ live: null, defaults: null });
  useEffect(() => {
    if (harness !== 'codex') return;
    let on = true;
    void loadCodexInfo().then((i) => { if (on) setInfo(i); });
    return () => { on = false; };
  }, [harness]);
  if (harness !== 'codex') return undefined;
  const m = model ?? liveModel;
  return { levels: codexEffortsFor(m, info.live), defaultEffort: codexDefaultEffortFor(m, info.defaults) };
}

/** The efforts to offer for a thread: a Codex model's own list, else undefined (the harness's fixed list). */
export function useEffortLevels(harness: SlashHarness | null, model: string | null, liveModel?: string): readonly string[] | undefined {
  return useCodexModelInfo(harness, model, liveModel)?.levels;
}

const NOT_YET = 'Model and effort changes for this agent are not available yet.';

/** The picker for a Pretty thread or an overseer: the model name in the status row under the composer. */
export function ThreadModelControl({ terminalId, liveModel, mobile }: { terminalId: string; liveModel?: string; mobile: boolean }) {
  const { harness, model, effort } = useThreadSettings(terminalId);
  const codexInfo = useCodexModelInfo(harness, model, liveModel);
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
      efforts={codexInfo?.levels}
      defaultEffort={codexInfo?.defaultEffort}
      onApply={(change) => applyThreadSettings(terminalId, change)}
    />
  );
}
