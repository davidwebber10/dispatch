import { Plus } from '@phosphor-icons/react';

/**
 * The phone app header's square buttons right of the search (Projects and Threads, owner 2026-11-27:
 * "Put them at the top just like projects"). One size and one look for both lists.
 */
export const PHONE_HEADER_BTN_SIZE = 36;
export const PHONE_HEADER_ICON_SIZE = 18;

/** The quiet square button: Sort on Projects, Filters on Threads. */
export const PHONE_HEADER_BTN: React.CSSProperties = {
  width: PHONE_HEADER_BTN_SIZE, height: PHONE_HEADER_BTN_SIZE, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-secondary)', cursor: 'pointer',
};

/** The green + (a new project, or a new thread). */
export function PhoneHeaderPlus({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      style={{ width: PHONE_HEADER_BTN_SIZE, height: PHONE_HEADER_BTN_SIZE, padding: 0, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-on-accent)', cursor: 'pointer' }}>
      <Plus size={PHONE_HEADER_ICON_SIZE} weight="bold" />
    </button>
  );
}
