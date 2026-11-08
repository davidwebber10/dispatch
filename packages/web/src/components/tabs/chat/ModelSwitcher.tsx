import { useEffect, useMemo, useState } from 'react';
import { ArrowsLeftRight, CaretDown, Check, Cpu } from '@phosphor-icons/react';
import type { Terminal } from '../../../api/types';
import { api } from '../../../api/client';
import { useActiveModel, useActiveModelFor } from '../../../stores/activeModel';
import { useTabs } from '../../../stores/tabs';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { friendlyModelName, isSameModel, modelOptionsFor, type NamedModel } from '../../../lib/modelName';
import { Spinner } from '../../common/Spinner';
import { Modal } from '../../common/Modal';

/** The user's OpenCode model list, loaded once per page (it arrives with the harness settings). */
let opencodeCache: NamedModel[] | null = null;
function useOpencodeModels(enabled: boolean): NamedModel[] {
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

/**
 * The Pretty composer's model chip: the model the thread runs NOW (useActiveModelFor — the
 * harness's newest report, else the saved model) and, on a tap, the harness's models to switch
 * to. A pick switches from the next turn and keeps the conversation (POST /terminals/:id/model).
 *
 * Disabled while a turn runs: a switch mid-turn would change the model under a running tool loop
 * (Claude) or apply only to the next turn anyway (Codex), so it waits, and says so, instead of
 * queueing a change the owner cannot see take effect. The list opens as a sheet on the phone and
 * as the centered card on the desktop (Modal's `sheet` rule).
 */
export function ModelSwitcher({ tab, busy }: { tab: Terminal; busy: boolean }) {
  const isMobile = useIsMobile();
  const active = useActiveModelFor(tab);
  const opencodeModels = useOpencodeModels(tab.type === 'opencode');
  const label = friendlyModelName(active, opencodeModels) ?? 'Default model';
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => modelOptionsFor(tab.type, opencodeModels, active), [tab.type, opencodeModels, active]);

  const pick = async (value: string) => {
    if (saving) return;
    if (isSameModel(value, active)) { setOpen(false); return; }
    setSaving(value); setError(null);
    try {
      const out = await api.setThreadModel(tab.id, value);
      useActiveModel.getState().set(tab.id, out.model || value);
      void useTabs.getState().loadTabs(tab.sessionId);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch the model.');
    } finally {
      setSaving(null);
    }
  };

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: isMobile ? '12px 12px' : '9px 10px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', cursor: 'pointer', font: 'inherit' };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-label={`Model: ${label}`}
        title={busy ? 'You can switch the model when the turn ends' : 'Switch model'}
        onClick={() => { setError(null); setOpen(true); }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: isMobile ? 190 : 240,
          height: isMobile ? 28 : 22, padding: isMobile ? '0 9px' : '0 7px',
          background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-pill)',
          color: 'var(--color-text-secondary)', font: `500 ${isMobile ? 12 : 11}px var(--font-sans)`,
          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
        }}
      >
        <Cpu size={isMobile ? 13 : 12} weight="bold" style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <CaretDown size={10} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
      </button>
      {open && (
        <Modal open sheet={isMobile} title="Switch model" onClose={() => setOpen(false)} maxWidth={400}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              The next message runs on the model you pick. The conversation stays.
            </span>
            {options.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
                {tab.type === 'opencode' ? 'Add models in Settings → Agents → OpenCode.' : 'This harness has no models to pick.'}
              </span>
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
            {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</div>}
          </div>
        </Modal>
      )}
    </>
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
