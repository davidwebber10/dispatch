import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { usePluginRegistry } from './registry';
import { PluginView, Slot } from './PluginView';
import { PluginBoundary } from './PluginBoundary';

const Boom = () => { throw new Error('kaboom'); };
const Fine = () => <div>fine content</div>;

beforeEach(() => {
  usePluginRegistry.setState({ manifests: [], status: {}, views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], promoted: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PluginView and Slot (2026-11-07)', () => {
  it("PluginView renders the view, and a throw shows the plugin's name in an alert, not a blank", () => {
    usePluginRegistry.getState().register('good', { views: [{ id: 'v', label: 'V', Component: Fine }] });
    usePluginRegistry.getState().register('bad', { views: [{ id: 'v', label: 'V', Component: Boom }] });
    const { unmount } = render(<PluginView viewKey="plugin:good:v" />);
    expect(screen.getByText('fine content')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-view')).toHaveAttribute('data-plugin', 'good');
    unmount();
    render(<PluginView viewKey="plugin:bad:v" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The plugin "bad" failed');
    expect(alert).toHaveTextContent('kaboom');
  });

  it('PluginView for an unknown key says the screen is not loaded', () => {
    render(<PluginView viewKey="plugin:nope:v" />);
    expect(screen.getByText('This plugin screen is not loaded.')).toBeInTheDocument();
  });

  it('a boundary resets when the plugin reloads (resetKey changes)', () => {
    let fail = true;
    const Flaky = () => { if (fail) throw new Error('first load'); return <div>second load</div>; };
    const { rerender } = render(<PluginBoundary plugin="p" resetKey={1}><Flaky /></PluginBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('first load');
    fail = false;
    rerender(<PluginBoundary plugin="p" resetKey={2}><Flaky /></PluginBoundary>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('second load')).toBeInTheDocument();
  });

  it('Slot renders every content for its name and nothing for another, passing props', () => {
    const Show = ({ who }: Record<string, unknown>) => <span>hello {String(who)}</span>;
    usePluginRegistry.getState().register('a', { slots: [{ id: 's', slot: 'thread.header.actions', Component: Show }] });
    usePluginRegistry.getState().register('b', { slots: [{ id: 's', slot: 'thread.header.actions', Component: Fine }, { id: 'other', slot: 'composer.before', Component: Boom }] });
    const { container } = render(<Slot name="thread.header.actions" who="dave" />);
    expect(screen.getByText('hello dave')).toBeInTheDocument();
    expect(screen.getByText('fine content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.textContent).not.toContain('kaboom');
  });

  it('an empty slot renders nothing', () => {
    const { container } = render(<Slot name="nothing.here" />);
    expect(container.innerHTML).toBe('');
  });

  it('one slot content throwing leaves the others rendered', () => {
    usePluginRegistry.getState().register('a', { slots: [{ id: 's', slot: 'x', Component: Boom }] });
    usePluginRegistry.getState().register('b', { slots: [{ id: 's', slot: 'x', Component: Fine }] });
    render(<Slot name="x" />);
    expect(screen.getByRole('alert')).toHaveTextContent('The plugin "a" failed');
    expect(screen.getByText('fine content')).toBeInTheDocument();
  });

  it('slot contents order by priority, higher first, then registration order', () => {
    const A = () => <i>A</i>; const B = () => <i>B</i>; const C = () => <i>C</i>;
    usePluginRegistry.getState().register('p1', { slots: [{ id: 'a', slot: 'x', Component: A }] });
    usePluginRegistry.getState().register('p2', { slots: [{ id: 'b', slot: 'x', priority: 10, Component: B }, { id: 'c', slot: 'x', Component: C }] });
    const { container } = render(<Slot name="x" />);
    expect(container.textContent).toBe('BAC');
  });
});
