import { useEffect, useMemo, useState } from 'react';
import type { Terminal } from '../../../api/types';
import { api } from '../../../api/client';
import { useActiveModel, useActiveModelFor } from '../../../stores/activeModel';
import { useTabs } from '../../../stores/tabs';
import { friendlyModelName, modelOptionsFor, type ModelOption, type NamedModel } from '../../../lib/modelName';
import { EFFORT_LEVELS, codexDefaultEffortFor, codexEffortsFor, type SlashHarness } from '../../../lib/slash';

// ---------------------------------------------------------------------------------------------------------------
// The model and effort controls of a Pretty thread, in one place: the chip in the status row (ModelSwitcher) and the
// "/" menu's /model and /effort both use them, so the two cannot disagree about the list, the current value or what a
// change does. The model part is the Pretty model switcher (POST /terminals/:id/model); the effort part sits beside it.
// ---------------------------------------------------------------------------------------------------------------

const HARNESS_TYPES = new Set(['claude-code', 'codex', 'grok', 'opencode']);
export const harnessOf = (type: string | undefined): SlashHarness | null => (type && HARNESS_TYPES.has(type) ? (type as SlashHarness) : null);

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
export function resetCodexInfoCache(): void { codexInfo = null; }

export interface EffortInfo {
  /** The levels to offer for this thread's model. */
  levels: readonly string[];
  /** The saved level, or null (the model's own default). */
  current: string | null;
  /** Codex: the level the model runs at when none is saved, so the list says what really runs. */
  defaultEffort?: string;
}

/** The effort levels of a thread, or undefined for a harness without an effort control yet (Grok, OpenCode). */
export function useEffortInfo(harness: SlashHarness | null, savedEffort: string | null, model: string | undefined): EffortInfo | undefined {
  const [info, setInfo] = useState<CodexInfo>({ live: null, defaults: null });
  useEffect(() => {
    if (harness !== 'codex') return;
    let on = true;
    void loadCodexInfo().then((i) => { if (on) setInfo(i); });
    return () => { on = false; };
  }, [harness]);
  if (harness === 'claude-code') return { levels: EFFORT_LEVELS['claude-code'], current: savedEffort };
  if (harness === 'codex') return { levels: codexEffortsFor(model, info.live), current: savedEffort, defaultEffort: codexDefaultEffortFor(model, info.defaults) };
  return undefined;
}

/** The user's OpenCode model list, loaded once per page (it arrives with the harness settings). */
let opencodeCache: NamedModel[] | null = null;
export function useOpencodeModels(enabled: boolean): NamedModel[] {
  const [list, setList] = useState<NamedModel[]>(opencodeCache ?? []);
  useEffect(() => {
    if (!enabled || opencodeCache) return;
    let live = true;
    api.getHarnessSettings()
      .then((hs) => { opencodeCache = hs?.opencodeModels ?? []; if (live) setList(opencodeCache); })
      .catch(() => {});
    return () => { live = false; };
  }, [enabled]);
  return list;
}

export interface ThreadModelControls {
  harness: SlashHarness | null;
  /** The model the thread runs now (reported, else saved), and the list a switch offers. */
  active: string | undefined;
  options: ModelOption[];
  label: string;
  effort?: EffortInfo;
  opencodeModels: NamedModel[];
  /** Switch the model. Resolves with a note when the daemon changed the effort too (Codex). Throws the daemon's words. */
  pickModel: (value: string) => Promise<string | undefined>;
  /** Change the effort. Resolves with the note to show. Throws the daemon's words. */
  pickEffort: (level: string) => Promise<string>;
}

export function useThreadModelControls(tab: Pick<Terminal, 'id' | 'sessionId' | 'type' | 'config'>): ThreadModelControls {
  const harness = harnessOf(tab.type);
  const active = useActiveModelFor(tab);
  const opencodeModels = useOpencodeModels(tab.type === 'opencode');
  const options = useMemo(() => modelOptionsFor(tab.type, opencodeModels, active), [tab.type, opencodeModels, active]);
  const saved = (tab.config as { effort?: unknown } | undefined)?.effort;
  const effort = useEffortInfo(harness, typeof saved === 'string' && saved ? saved : null, active);
  const label = friendlyModelName(active, opencodeModels) ?? 'Default model';

  const pickModel = async (value: string): Promise<string | undefined> => {
    const out = await api.setThreadModel(tab.id, value);
    useActiveModel.getState().set(tab.id, out.model || value);
    void useTabs.getState().loadTabs(tab.sessionId);
    if (out.effortNow) {
      return out.clearedEffort
        ? `Effort ${out.clearedEffort} is not available on this model, so it now runs at ${out.effortNow}.`
        : `Effort is now ${out.effortNow}, this model's default.`;
    }
    return undefined;
  };
  const pickEffort = async (level: string): Promise<string> => {
    await api.setThreadEffort(tab.id, level);
    void useTabs.getState().loadTabs(tab.sessionId);
    return 'Effort changed. Applies from the next message.';
  };
  return { harness, active, options, label, effort, opencodeModels, pickModel, pickEffort };
}
