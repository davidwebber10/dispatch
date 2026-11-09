import { useEffect, useState } from 'react';
import { ArrowsLeftRight, CaretDown, Check, Cpu } from '@phosphor-icons/react';
import type { Terminal } from '../../../api/types';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { friendlyModelName, isSameModel, type ModelOption, type NamedModel } from '../../../lib/modelName';
import { usePickerRequest } from '../../../stores/pickerRequest';
import { useThreadModelControls, type EffortInfo } from './modelControls';
import { Spinner } from '../../common/Spinner';
import { Modal } from '../../common/Modal';

/**
 * The model chip of a Pretty composer, and the one place a model or an effort is chosen: the model the thread runs NOW
 * and, on a tap, the harness's models to switch to and (Claude and Codex) the effort levels. A model pick switches from
 * the next turn and keeps the conversation (POST /terminals/:id/model); an effort pick likewise (POST /terminals/:id/effort).
 * The "/" menu's /model and /effort use the same lists and the same calls (modelControls.ts), and open this card for a
 * bare command (stores/pickerRequest).
 *
 * Disabled while a turn runs: a switch mid-turn would change the model under a running tool loop (Claude) or apply
 * only to the next turn anyway (Codex), so it waits, and says so, instead of queueing a change the owner cannot see
 * take effect. The list opens as a sheet on the phone and as the centered card on the desktop (Modal's `sheet` rule).
 */
export interface ModelChipProps {
  /** Names this chip for the "/" menu to open: `thread:<id>` or `chat`. */
  owner: string;
  label: string;
  active: string | undefined;
  options: ModelOption[];
  busy: boolean;
  emptyText?: string;
  opencodeModels?: NamedModel[];
  /** Switch the model. May resolve with a note to show (the card then stays open). Throws the daemon's words. */
  pickModel: (value: string) => Promise<string | undefined | void>;
  /** Called when the card opens (Chat reloads its settings here, in case another device changed them). */
  onOpen?: () => void;
  /** Send a pick even when it looks like the current one: a chip that may be stale (Chat, shared by several devices) must not decide that. */
  alwaysSend?: boolean;
  /** The effort section: absent for a harness without an effort control yet (Grok, OpenCode). */
  effort?: EffortInfo & { pick: (level: string) => Promise<string | undefined | void> };
}

export function ModelChip({ owner, label, active, options, busy, emptyText = 'This harness has no models to pick.', pickModel, effort, onOpen, alwaysSend }: ModelChipProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // The "/" menu asks for this card by owner (a bare /model or /effort). Not while a turn runs, like the chip.
  const requested = usePickerRequest((s) => s.owner === owner);
  useEffect(() => {
    if (!requested) return;
    usePickerRequest.getState().clear();
    if (!busy) { setError(null); setNote(null); setOpen(true); onOpen?.(); }
  }, [requested, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (value: string) => {
    if (saving) return;
    if (!alwaysSend && isSameModel(value, active)) { setOpen(false); return; }
    setSaving(value); setError(null); setNote(null);
    try {
      const said = await pickModel(value);
      if (said) setNote(said); else setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch the model.');
    } finally {
      setSaving(null);
    }
  };
  const pickLevel = async (level: string) => {
    if (saving || !effort) return;
    setSaving(`effort:${level}`); setError(null); setNote(null);
    try {
      const said = await effort.pick(level);
      if (said) setNote(said);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the effort.');
    } finally {
      setSaving(null);
    }
  };

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: isMobile ? '12px 12px' : '9px 10px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', cursor: 'pointer', font: 'inherit' };
  const shownEffort = effort ? effort.current ?? effort.defaultEffort ?? null : null;

  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-label={`Model: ${label}${effort?.current ? `, effort ${effort.current}` : ''}`}
        title={busy ? 'You can switch the model when the turn ends' : effort ? 'Switch model or effort' : 'Switch model'}
        onClick={() => { setError(null); setNote(null); setOpen(true); onOpen?.(); }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: isMobile ? 190 : 240,
          height: isMobile ? 28 : 22, padding: isMobile ? '0 9px' : '0 7px',
          background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-pill)',
          color: 'var(--color-text-secondary)', font: `500 ${isMobile ? 12 : 11}px var(--font-sans)`,
          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
        }}
      >
        <Cpu size={isMobile ? 13 : 12} weight="bold" style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}{effort?.current ? ` · ${effort.current}` : ''}</span>
        <CaretDown size={10} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
      </button>
      {open && (
        <Modal open sheet={isMobile} title={effort ? 'Model and effort' : 'Switch model'} onClose={() => setOpen(false)} maxWidth={400}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              The next message runs on what you pick. The conversation stays.
            </span>
            {options.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>{emptyText}</span>
            ) : (
              <div role="radiogroup" aria-label="Model" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {options.map((o) => {
                  const on = isSameModel(o.value, active);
                  return (
                    <button key={o.value} type="button" role="radio" aria-checked={on} aria-label={o.label} disabled={!!saving}
                      onClick={() => void pick(o.value)}
                      style={{ ...row, borderColor: on ? 'var(--color-accent)' : 'var(--color-border)', cursor: saving ? 'default' : 'pointer' }}>
                      <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', color: 'var(--color-accent)' }}>
                        {saving === o.value ? <Spinner size={12} /> : on && <Check size={14} weight="bold" />}
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span style={{ fontSize: isMobile ? 15 : 13.5, fontWeight: 500 }}>{o.label}</span>
                        {o.hint && o.hint !== o.label && (
                          <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {on && active && active !== o.value ? active : o.hint}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {effort && (
              <>
                <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 }}>Effort for this thread</span>
                <div role="radiogroup" aria-label="Effort" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {effort.levels.map((l) => {
                    const on = shownEffort === l;
                    const isDefault = on && effort.current === null;
                    return (
                      <button key={l} type="button" role="radio" aria-checked={on} aria-label={l} disabled={!!saving}
                        onClick={() => void pickLevel(l)}
                        style={{ ...row, width: 'auto', gap: 6, padding: isMobile ? '10px 14px' : '6px 12px', borderColor: on ? 'var(--color-accent)' : 'var(--color-border)', cursor: saving ? 'default' : 'pointer' }}>
                        {saving === `effort:${l}` ? <Spinner size={12} /> : on && <Check size={13} weight="bold" color="var(--color-accent)" />}
                        <span style={{ fontSize: isMobile ? 14 : 13 }}>{l}</span>
                        {isDefault && <span style={{ font: '400 11px var(--font-sans)', color: 'var(--color-text-tertiary)' }}>model default</span>}
                      </button>
                    );
                  })}
                </div>
                {effort.current === null && !effort.defaultEffort && (
                  <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No effort set: the model's own default.</span>
                )}
              </>
            )}
            {note && <div role="status" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{note}</div>}
            {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</div>}
          </div>
        </Modal>
      )}
    </>
  );
}

/** The Pretty composer's model chip for a thread (or an overseer): the 4.2.0 chip fed by modelControls.ts. */
export function ModelSwitcher({ tab, busy }: { tab: Terminal; busy: boolean }) {
  const c = useThreadModelControls(tab);
  return (
    <ModelChip
      owner={`thread:${tab.id}`}
      label={c.label}
      active={c.active}
      options={c.options}
      busy={busy}
      emptyText={tab.type === 'opencode' ? 'Add models in Settings → Agents → OpenCode.' : 'This harness has no models to pick.'}
      pickModel={c.pickModel}
      effort={c.effort ? { ...c.effort, pick: c.pickEffort } : undefined}
    />
  );
}

/** The chat line a switch leaves (a `system` item with systemKind 'model'). */
export function ModelNotice({ model }: { model: string }) {
  const name = friendlyModelName(model) ?? model;
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', color: 'var(--color-text-tertiary)' }}>
      <span aria-hidden="true" style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5 }} title={model}>
        <ArrowsLeftRight size={12} weight="bold" />
        {`Model switched to ${name}`}
      </span>
      <span aria-hidden="true" style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
    </div>
  );
}
