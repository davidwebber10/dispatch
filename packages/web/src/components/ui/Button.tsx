import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { CircleNotch } from '@phosphor-icons/react';
import './ui.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export type ButtonProps = {
  /** `primary`: the filled accent button. `secondary`: a quiet filled button (Cancel in a dialog).
   *  `ghost`: an outline (most buttons on a Settings page). `danger`: the outline in red; in the
   *  action row of a confirm dialog it is filled red. */
  variant: ButtonVariant;
  /** `sm` is 30px tall (a page), `md` is 34px (a dialog's action row). */
  size: ButtonSize;
  /** A Phosphor icon, shown before the label. */
  icon?: ReactNode;
  /** Work is under way: the button is disabled and shows a spinner. Its width does not change. */
  loading?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * The app's button (engineering program 2026-11-09, W3-E). Its look is classes in ui.css; pass
 * `style` only for layout in the parent (`flex: 1`, `alignSelf`) or a phone's taller touch height.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, loading = false, className, children, disabled, type = 'button', ...rest }, ref,
) {
  const cls = ['ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, loading ? 'ui-btn--loading' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {icon !== undefined && icon !== null && icon !== false && <span className="ui-btn__icon" aria-hidden="true">{icon}</span>}
      <span className="ui-btn__label">{children}</span>
      {loading && <span className="ui-btn__spinner" aria-hidden="true"><CircleNotch className="endless-spin" size={size === 'md' ? 16 : 14} weight="bold" /></span>}
    </button>
  );
});
