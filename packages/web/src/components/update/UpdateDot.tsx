import { useUpdate, updatePending } from '../../stores/update';

/**
 * A plain dot (no count) on the Settings entry — the phone's bottom tab and the desktop rail
 * item — while an update waits. Same accent as the previews badge, with a ring in the pane
 * colour so it reads over the icon's edge. The caller positions it (`style`) inside a
 * `position: relative` parent.
 */
export function UpdateDot({ style }: { style?: React.CSSProperties }) {
  const pending = useUpdate(updatePending);
  if (!pending) return null;
  return (
    <span aria-label="Update available" role="status" style={{
      position: 'absolute', width: 8, height: 8, borderRadius: '50%',
      background: 'var(--color-accent)', boxShadow: '0 0 0 2px var(--color-pane)', ...style,
    }} />
  );
}
