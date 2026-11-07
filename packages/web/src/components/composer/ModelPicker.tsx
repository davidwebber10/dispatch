import { useEffect, useRef, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { HARNESSES } from '../../lib/harnesses';
import { EFFORT_LEVELS, type SlashHarness } from '../../lib/slash';
import { modelDisplayName } from '../ContextIndicator';
import { usePickerRequest } from '../../stores/pickerRequest';

/**
 * The model and effort picker (slash menu, 2026-11-06). The model name in the status row under the
 * composer is its button. It lists the models the New Thread modal offers for the harness (the same
 * catalog) and the effort levels, and says when a change takes hold. A phone gets the shared bottom
 * sheet; a desktop gets a small panel above the button.
 *
 * It owns no data: the host passes the saved choice and an `onApply` that makes the change.
 * `onApply` returns the note to show ("Applies from the next turn") or throws an Error whose message
 * is shown.
 */
export interface ModelControlProps {
  /** Names the picker for the "/" menu to open: `thread:<id>` or `chat`. */
  owner: string;
  harness: SlashHarness;
  /** The saved choice (null = the default). */
  model: string | null;
  effort: string | null;
  /** What the harness reports it runs, for the label when nothing is saved. */
  liveModel?: string;
  /** Chat only: the model the default runs, for the "Default" row and the label. */
  defaultModel?: string;
  /** Set when the harness cannot change yet: the label stays text and says why. */
  disabledReason?: string;
  onApply: (change: { model?: string | null; effort?: string }) => Promise<string | void>;
  mobile: boolean;
  /** The efforts to offer, when they depend on the model (Codex). Default: the harness's fixed list. */
  efforts?: readonly string[];
}

/** The catalog models for a harness; Codex has no "Default" (a thread cannot go back to it). */
export function pickerModels(harness: SlashHarness): { label: string; model: string | null }[] {
  const type = harness;
  const list = HARNESSES.find((h) => h.type === type)?.models ?? [];
  return harness === 'codex' ? list.filter((m) => m.model !== null) : list;
}

/** "Opus", "Opus 5.5 · high": the trigger's text. */
export function modelControlLabel(p: Pick<ModelControlProps, 'harness' | 'model' | 'effort' | 'liveModel' | 'defaultModel'>): string {
  const catalog = pickerModels(p.harness);
  // A Codex id is shown whole when the catalog has no name for it ('gpt-6-luna'); the Claude name shortener would cut it to 'Gpt 6'.
  const nameOf = (id: string) => catalog.find((m) => m.model === id)?.label ?? (p.harness === 'codex' ? id : modelDisplayName(id));
  let name: string | undefined;
  if (p.model) {
    const family = /^claude-([a-z]+)-/.exec(p.liveModel ?? '')?.[1];
    name = family && family === p.model ? modelDisplayName(p.liveModel) : nameOf(p.model);
  } else {
    const id = p.liveModel ?? p.defaultModel;
    name = id ? nameOf(id) : undefined;
  }
  name ??= 'Model';
  return p.effort ? `${name} · ${p.effort}` : name;
}

const NOTE = 'Applies from the next turn.';

export function ModelControl(props: ModelControlProps) {
  const { owner, harness, model, effort, defaultModel, disabledReason, onApply, mobile } = props;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ kind: 'busy' | 'ok' | 'error'; text?: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const label = modelControlLabel(props);

  // The "/" menu asks for this picker by owner.
  const requested = usePickerRequest((s) => s.owner === owner);
  useEffect(() => {
    if (!requested) return;
    usePickerRequest.getState().clear();
    if (!disabledReason) { setStatus(null); setOpen(true); }
  }, [requested, disabledReason]);

  useEffect(() => {
    if (!open || mobile) return;
    const onDoc = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, mobile]);

  if (disabledReason) {
    return <span title={disabledReason} style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{label}</span>;
  }

  async function apply(change: { model?: string | null; effort?: string }) {
    setStatus({ kind: 'busy' });
    try {
      const note = await onApply(change);
      setStatus({ kind: 'ok', text: note || NOTE });
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof Error ? e.message : 'The change did not go through.' });
    }
  }

  const models = pickerModels(harness);
  const levels = props.efforts ?? (harness === 'claude-code' || harness === 'codex' ? EFFORT_LEVELS[harness] : []);
  const row = (selected: boolean) => ({
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: mobile ? '12px 12px' : '7px 10px', background: selected ? 'var(--color-hover, rgba(255,255,255,.06))' : 'none',
    border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', font: `500 ${mobile ? 15 : 13}px var(--font-sans)`, cursor: 'pointer', textAlign: 'left' as const,
  });
  const heading = { padding: '6px 10px 2px', font: '600 10.5px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase' as const, color: 'var(--color-text-tertiary)' };

  const body = (
    <div role="dialog" aria-label="Model and effort" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={heading}>Model</div>
      {models.map((m) => {
        const selected = m.model === null ? model === null : model === m.model;
        const text = m.model === null && defaultModel ? `Default (${modelDisplayName(defaultModel) ?? defaultModel})` : m.label;
        return (
          <button key={m.model ?? 'default'} type="button" aria-pressed={selected} style={row(selected)} onClick={() => void apply({ model: m.model })}>
            <span style={{ flex: 1 }}>{text}</span>
            {selected && <Check size={14} weight="bold" color="var(--color-accent)" />}
          </button>
        );
      })}
      <div style={{ ...heading, paddingTop: 10 }}>Effort</div>
      {levels.map((l) => {
        const selected = effort === l;
        return (
          <button key={l} type="button" aria-pressed={selected} style={row(selected)} onClick={() => void apply({ effort: l })}>
            <span style={{ flex: 1 }}>{l}</span>
            {selected && <Check size={14} weight="bold" color="var(--color-accent)" />}
          </button>
        );
      })}
      {effort === null && <div style={{ padding: '2px 10px', font: '400 11px var(--font-sans)', color: 'var(--color-text-tertiary)' }}>No effort set: the model's own default.</div>}
      <div role="status" style={{ padding: '8px 10px 4px', font: '400 11.5px var(--font-sans)', minHeight: 16, color: status?.kind === 'error' ? 'var(--color-status-red)' : 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
        {status?.kind === 'busy' ? <Spinner size={10} /> : null}
        {status?.kind === 'busy' ? 'Saving…' : status?.text ?? NOTE}
      </div>
    </div>
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Change the model and effort"
        onClick={() => { setStatus(null); setOpen((o) => !o); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: 'var(--color-text-secondary)', font: '500 11px var(--font-mono)', borderRadius: 'var(--radius-xs)' }}
      >
        {label}
      </button>
      {mobile ? (
        <Modal open={open} sheet title="Model and effort" onClose={() => setOpen(false)}>{body}</Modal>
      ) : open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, minWidth: 220, padding: 6, zIndex: 40,
          background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 12px 34px -10px rgba(0,0,0,.7)',
        }}>{body}</div>
      )}
    </div>
  );
}
