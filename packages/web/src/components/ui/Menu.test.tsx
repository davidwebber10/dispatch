import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { Menu, type MenuItem } from './Menu';

function Harness({ items, onClose = () => {} }: { items: MenuItem[]; onClose?: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} onClick={() => setOpen(true)}>Actions</button>
      <button>Elsewhere</button>
      <Menu open={open} anchor={ref} label="Thread actions" items={items} onClose={() => { onClose(); setOpen(false); }} />
    </>
  );
}

const three = (spy = vi.fn()): MenuItem[] => [
  { id: 'rename', label: 'Rename', onSelect: () => spy('rename') },
  { id: 'move', label: 'Move', onSelect: () => spy('move'), disabled: true },
  { id: 'archive', label: 'Archive', onSelect: () => spy('archive') },
  { separator: true },
  { id: 'delete', label: 'Delete', danger: true, onSelect: () => spy('delete') },
];

function openMenu() {
  const opener = screen.getByText('Actions');
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('Menu', () => {
  it('opens with the first item active, and is a labelled menu', () => {
    render(<Harness items={three()} />);
    openMenu();
    expect(screen.getByRole('menu', { name: 'Thread actions' })).toHaveClass('ui-menu');
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
  });

  it('arrow keys move the active item', () => {
    render(<Harness items={three()} />);
    openMenu();
    const menu = screen.getByRole('menu');
    const item = (name: string) => screen.getByRole('menuitem', { name });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Archive')); // the disabled item is skipped
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Delete'));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Rename')); // wraps
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(item('Delete'));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(item('Rename'));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(item('Delete'));
    // One tab stop: only the active item is in the tab order.
    expect(item('Delete')).toHaveAttribute('tabindex', '0');
    expect(item('Rename')).toHaveAttribute('tabindex', '-1');
  });

  it('Escape closes and returns focus', () => {
    const onClose = vi.fn();
    render(<Harness items={three()} onClose={onClose} />);
    const opener = openMenu();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('an outside press closes', () => {
    const onClose = vi.fn();
    render(<Harness items={three()} onClose={onClose} />);
    openMenu();
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a pick runs the item and closes; a disabled item does nothing', () => {
    const spy = vi.fn();
    const onClose = vi.fn();
    render(<Harness items={three(spy)} onClose={onClose} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move' }));
    expect(spy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(spy).toHaveBeenCalledWith('archive');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('marks a destructive item with a class, and Tab closes the menu', () => {
    const onClose = vi.fn();
    render(<Harness items={three()} onClose={onClose} />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass('ui-menu__item--danger');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
