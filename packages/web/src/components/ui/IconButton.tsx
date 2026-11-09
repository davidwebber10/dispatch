import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './ui.css';

export type IconButtonProps = {
  /** Required: what the button does. It is the accessible name and the hover title. */
  label: string;
  /** A Phosphor icon. */
  icon: ReactNode;
  /** `sm` is a 24px square (a row action), `md` is 32px (a header action). */
  size?: 'sm' | 'md';
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'>;

/**
 * A button that is only an icon. It has no padding and a fixed square, so the icon is never
 * squeezed, and it always has a name for a screen reader.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', className, title, type = 'button', ...rest }, ref,
) {
  const cls = ['ui-icon-btn', `ui-icon-btn--${size}`, className ?? ''].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} aria-label={label} title={title ?? label} {...rest}>
      <span className="ui-icon-btn__icon" aria-hidden="true">{icon}</span>
    </button>
  );
});
