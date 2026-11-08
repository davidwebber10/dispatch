import { fireEvent, screen, within } from '@testing-library/react';

/**
 * Drive the shared Select (components/common/Select, a combobox + listbox) the way a person does:
 * open it, then click the option. The replacement for `fireEvent.change(select, ...)` on the old
 * native selects. `name` is the combobox's accessible name; `scope` narrows where it is found.
 */
export function pickOption(name: string | RegExp, option: string | RegExp, scope: HTMLElement = document.body): void {
  const combo = within(scope).getByRole('combobox', { name });
  if (combo.getAttribute('aria-expanded') !== 'true') fireEvent.click(combo);
  const list = screen.getByRole('listbox');
  fireEvent.click(within(list).getByRole('option', { name: option }));
}

/** The label a Select shows: its current choice. */
export function selectedText(name: string | RegExp, scope: HTMLElement = document.body): string {
  return within(scope).getByRole('combobox', { name }).textContent ?? '';
}
