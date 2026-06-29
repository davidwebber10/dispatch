// Overseer — Delegate modal (spec §6 "Delegate modal", §7 copy, §8 icons, §9).
//
// Centered overlay: header (paper-plane + "Delegate a task" + X close), textarea
// bound to store.delegateText, recommendation line ("Overseer suggests a {type}…"),
// four AgentType chips, and footer Cancel / Delegate → actions. Same layout on
// desktop and mobile. Returns null when !delegateOpen (roots also guard with &&).

import { AGENT_TYPE, type AgentType } from '../types';
import { useOverseer } from '../store';
import { Icon } from '../atoms';

const AGENT_TYPES: AgentType[] = ['planner', 'implementer', 'researcher', 'reviewer'];

export function DelegateModal() {
  const delegateOpen    = useOverseer((s) => s.delegateOpen);
  const delegateText    = useOverseer((s) => s.delegateText);
  const delegateType    = useOverseer((s) => s.delegateType);
  const setDelegateText = useOverseer((s) => s.setDelegateText);
  const pickType        = useOverseer((s) => s.pickType);
  const doDelegate      = useOverseer((s) => s.doDelegate);
  const closeDelegate   = useOverseer((s) => s.closeDelegate);

  if (!delegateOpen) return null;

  const recommend = AGENT_TYPE[delegateType].label;

  return (
    /* Overlay */
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 50,
      }}
      onClick={(e) => {
        // close on backdrop click
        if (e.target === e.currentTarget) closeDelegate();
      }}
    >
      {/* Dialog */}
      <div
        style={{
          width: 480,
          background: '#18181B',
          border: '1px solid #2F2F35',
          borderRadius: 13,
          boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
          }}
        >
          <Icon name="ph-paper-plane-right" weight="fill" size={16} color="var(--acc)" />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tp)', flex: 1 }}>
            Delegate a task
          </span>
          <button
            onClick={closeDelegate}
            title="Close"
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: 'transparent',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ts)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <Icon name="ph-x" size={14} color="var(--ts)" />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 16 }}>
          {/* Textarea */}
          <textarea
            rows={3}
            value={delegateText}
            onChange={(e) => setDelegateText(e.target.value)}
            placeholder="Describe what you want done — the Overseer breaks it down…"
            style={{
              width: '100%',
              background: 'var(--pane)',
              border: '1px solid #2C2C32',
              borderRadius: 9,
              fontSize: 13,
              lineHeight: 1.5,
              padding: '10px 12px',
              color: 'var(--tp)',
              fontFamily: 'inherit',
              resize: 'none',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />

          {/* Recommendation line */}
          <div
            style={{
              margin: '14px 0 9px',
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 12.5,
              color: 'var(--ts)',
            }}
          >
            <Icon name="ph-broadcast" size={13} color="var(--acc)" />
            <span>
              Overseer suggests a{' '}
              <strong style={{ color: 'var(--acc)', fontWeight: 600 }}>{recommend}</strong>
              {' '}— switch the type if you&apos;d rather.
            </span>
          </div>

          {/* Type chips */}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {AGENT_TYPES.map((t) => {
              const selected = t === delegateType;
              const info = AGENT_TYPE[t];
              return (
                <button
                  key={t}
                  onClick={() => pickType(t)}
                  data-type={t}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 12px',
                    borderRadius: 9,
                    background: selected ? 'var(--accDim)' : 'var(--pane)',
                    color: selected ? 'var(--acc)' : 'var(--ts)',
                    border: selected
                      ? '1px solid var(--accLine)'
                      : '1px solid var(--border)',
                    fontSize: 12,
                    fontFamily: 'inherit',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  <Icon name={info.icon} size={14} color={selected ? 'var(--acc)' : 'var(--ts)'} />
                  {info.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '13px 16px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 9,
          }}
        >
          {/* Cancel */}
          <button
            onClick={closeDelegate}
            style={{
              padding: '7px 13px',
              borderRadius: 8,
              background: 'transparent',
              color: 'var(--ts)',
              border: '1px solid var(--border)',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>

          {/* Delegate → */}
          <button
            onClick={doDelegate}
            style={{
              padding: '7px 13px',
              borderRadius: 8,
              background: 'var(--acc)',
              color: '#06140B',
              border: '1px solid var(--acc)',
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            Delegate
            <Icon name="ph-arrow-right" weight="bold" size={13} color="#06140B" />
          </button>
        </div>
      </div>
    </div>
  );
}
