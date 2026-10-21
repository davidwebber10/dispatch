/** Small parts the Chat pane, the Docs list and the doc viewer share (kept apart so they do not import ProjectsPanel). */

const mono = (size: number, color = 'var(--color-text-tertiary)'): React.CSSProperties => ({ fontFamily: 'var(--font-mono)', fontSize: size, color });

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:02" today, "Sat 14:02" this week, "1 Sep" before that. Fixed names: ICU builds differ ("Sep" or "Sept"). */
export function formatStart(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return hm;
  if (days > 0 && days < 7) return `${WEEKDAY[d.getDay()]} ${hm}`;
  return `${d.getDate()} ${MONTH[d.getMonth()]}`;
}

/** The footer toggles of a project block ("+N more", "Done today (N)", "Docs (N)"). */
export function MoreButton({ children, onClick, expanded, mobile, first }: { children: React.ReactNode; onClick: () => void; expanded?: boolean; mobile: boolean; first: boolean }) {
  return (
    <button type="button" aria-expanded={expanded} onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'transparent', border: 0, cursor: 'pointer', textAlign: 'left',
        borderTop: first ? '1px solid var(--color-border)' : 0, marginTop: first ? 4 : 0,
        ...mono(12, expanded ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)'),
        ...(mobile ? { minHeight: 44, padding: 0 } : { padding: '7px 0 1px' }),
      }}>
      {children}
    </button>
  );
}
