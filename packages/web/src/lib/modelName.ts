import { HARNESSES } from './harnesses';

/** A model the user configured for OpenCode (Settings → Agents → OpenCode). */
export interface NamedModel { label: string; model: string }

const CLAUDE_ALIAS = /^(opus|sonnet|haiku|fable)$/;
const CLAUDE_FAMILY = /^claude-(opus|sonnet|haiku|fable)-/;
const SYNTHETIC = '<synthetic>';

const cap = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);

/**
 * The one human label for a model id in Pretty (header chip, switcher rows, the "Model switched"
 * notice). Works on what the harness REPORTS (a full id) and on what a thread SAVED (a Claude
 * tier alias, a Codex slug, an OpenRouter path):
 *   claude-opus-5-5 → "Opus 5.5", claude-opus-5-5[1m] → "Opus 5.5 (1M)", opus → "Opus",
 *   gpt-5.6-sol → "GPT-5.6 Sol", grok-4.7-build-fast → "Grok 4.7 Build Fast",
 *   an OpenCode id → its label from the user's list, else the last path segment.
 */
export function friendlyModelName(model: string | undefined | null, opencodeModels: NamedModel[] = []): string | undefined {
  if (!model) return undefined;
  const named = opencodeModels.find((m) => m.model === model);
  if (named) return named.label;
  if (CLAUDE_ALIAS.test(model)) return cap(model);
  if (model.startsWith('claude-')) {
    const ctx = /\[(\w+)\]$/.exec(model)?.[1];
    const base = model.replace(/\[\w+\]$/, '');
    const parts = base.replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p));
    const nums = parts.slice(1).filter((p) => /^\d+$/.test(p));
    const name = nums.length ? `${cap(parts[0])} ${nums.join('.')}` : cap(parts[0]);
    return ctx ? `${name} (${ctx.toUpperCase()})` : name;
  }
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(model);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].split('-').map(cap).join(' ') : ''}`;
  if (model.startsWith('grok-')) return model.split('-').map(cap).join(' ');
  if (model.includes('/')) return model.slice(model.lastIndexOf('/') + 1);
  return model;
}

/**
 * The model a structured-stream frame names, or undefined. The daemon's `system/model` (sent on
 * every connect and after a switch), Claude's per-turn `system/init` (Codex/ACP translate their
 * bind into one), and a LEAD assistant frame's `message.model` (what answered). A sub-agent's
 * frame (`parent_tool_use_id`) and Claude's own `<synthetic>` frames never count.
 */
export function modelFromFrame(e: any): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  if (e.type === 'system' && (e.subtype === 'init' || e.subtype === 'model')) {
    const m = e.model || e.session?.model || e.modelId;
    return typeof m === 'string' && m ? m : undefined;
  }
  if (e.type === 'assistant' && e.parent_tool_use_id == null) {
    const m = e.message?.model;
    return typeof m === 'string' && m && m !== SYNTHETIC ? m : undefined;
  }
  return undefined;
}

export interface ModelOption { value: string; label: string; hint?: string }

/**
 * The switcher's list for a thread type: the same models the New Thread modal offers (HARNESSES,
 * or the user's OpenCode list), minus "Default" — a live switch needs a concrete model. A model
 * the thread runs that the list lacks (a newer Grok, an OpenRouter id since removed) is kept on
 * top, so the current pick is always visible; a full Claude id whose family alias is listed is not.
 */
export function modelOptionsFor(type: string | undefined, opencodeModels: NamedModel[] = [], running?: string): ModelOption[] {
  const harness = HARNESSES.find((h) => h.type === type);
  const list: NamedModel[] = type === 'opencode'
    ? opencodeModels
    : (harness?.models ?? []).filter((m): m is NamedModel => !!m.model);
  const opts: ModelOption[] = list.map((m) => ({
    value: m.model,
    label: type === 'opencode' ? m.label : friendlyModelName(m.model) ?? m.label,
    hint: m.model,
  }));
  if (running && !opts.some((o) => o.value === running)) {
    const family = CLAUDE_FAMILY.exec(running)?.[1];
    if (!family || !opts.some((o) => o.value === family)) {
      opts.unshift({ value: running, label: friendlyModelName(running, opencodeModels) ?? running, hint: running });
    }
  }
  return opts;
}

/** True when `running` (a reported id) is the model `option` (a saved id or alias) names. */
export function isSameModel(option: string, running: string | undefined): boolean {
  if (!running) return false;
  if (option === running) return true;
  return CLAUDE_ALIAS.test(option) && CLAUDE_FAMILY.exec(running)?.[1] === option;
}
