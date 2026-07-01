// Overseer view — header "Needs you" alert + dropdown.
//
// Replaces the old surfaces: the desktop inline Needs hero (was above the stream) and
// the mobile "Needs you" tab both fold into this single header indicator. A ⚠ + count
// chip lives in the header; clicking it opens a popover holding the SAME `NeedsZone`
// panel. The chip is emphasized (yellow) while something is held and muted when calm.
// Shared by the desktop header (Header.tsx) and the mobile header (OverseerMobile.tsx).
//
// Reads only the store (useRenderVals) — no data props, per the module contract.

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../atoms';
import { useRenderVals } from '../store';
import { NeedsZone } from './NeedsZone';

// Calm empty state shown in the popover when nothing is held.
function AllClear() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 9,
        textAlign: 'center',
        padding: '26px 22px 28px',
      }}
    >
      <Icon name="ph-check-circle" weight="fill" size={26} color="var(--acc)" />
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--tp)' }}>All clear</div>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--ts)', maxWidth: 240 }}>
        Nothing needs you right now — everything else is handled.
      </div>
    </div>
  );
}

export function NeedsAlert() {
  const { ribbon } = useRenderVals();
  const { needs: count, hasNeeds } = ribbon;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click / Escape (a lightweight popover; no portal needed since the
  // dropdown is anchored inside the header wrapper).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 'none' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={
          hasNeeds ? `${count} ${count === 1 ? 'thing needs' : 'things need'} you` : 'Nothing needs you'
        }
        title={
          hasNeeds ? `${count} ${count === 1 ? 'thing needs' : 'things need'} you` : 'Nothing needs you'
        }
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '5px 10px',
          borderRadius: 8,
          background: hasNeeds ? 'var(--yellowDim)' : 'var(--elev)',
          border: `1px solid ${hasNeeds ? 'var(--yellowLine)' : 'var(--border)'}`,
          color: hasNeeds ? 'var(--yellow)' : 'var(--tt)',
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        <Icon name="ph-warning" weight="fill" size={13} color={hasNeeds ? 'var(--yellow)' : 'var(--tt)'} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700 }}>{count}</span>
      </button>

      {open && (
        <div
          role="dialog"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 380,
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: 'min(70vh, 560px)',
            overflowY: 'auto',
            background: 'var(--base)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 24px 70px -28px rgba(0,0,0,.85)',
            zIndex: 50,
          }}
        >
          {hasNeeds ? <NeedsZone /> : <AllClear />}
        </div>
      )}
    </div>
  );
}
