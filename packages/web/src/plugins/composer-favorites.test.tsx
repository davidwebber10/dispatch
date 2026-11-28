import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import { createPluginSdk } from './facade';
import { usePluginRegistry } from './registry';
// @ts-expect-error The example plugin is plain JS with no declaration file.
import activate from '../../../../docs/plugins/examples/composer-favorites/web.js';

/**
 * The Settings screen of the Composer favorites example: one list, a tap opens a row to edit it,
 * each change is written at once. The drag itself is SortableList's (its own test covers it).
 */
const ID = 'composer-favorites';
interface Fav { id?: string; label: string; text: string; mode?: string }
function fakeDaemon(initial?: Fav[]) {
  const state: { doc: Fav[] | undefined; puts: Fav[][] } = { doc: initial, puts: [] };
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!/\/data\/favorites$/.test(String(input))) return json(404, { error: 'nope' });
    if (method === 'GET') return state.doc ? json(200, { key: 'favorites', value: state.doc }) : json(404, { error: 'document not found' });
    state.doc = (JSON.parse(String(init?.body)) as { value: Fav[] }).value; state.puts.push(state.doc);
    return json(200, { key: 'favorites', value: null });
  }));
  return state;
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const actions = () => usePluginRegistry.getState().composerActions.map((a) => a.label);
async function open(initial?: Fav[], d: unknown = createPluginSdk(ID)) {
  const daemon = fakeDaemon(initial);
  (activate as (d: unknown) => void)(d);
  await settle();
  const Settings = usePluginRegistry.getState().settings[0].Component as React.ComponentType;
  render(<Settings />);
  await settle();
  return daemon;
}
const rows = () => screen.getAllByTestId('favorite');
const names = () => screen.getAllByTestId('favorite-name').map((b) => b.textContent);

beforeEach(() => {
  usePluginRegistry.setState({ manifests: [], status: {}, views: [], settings: [], threadMenu: [], projectMenu: [], composerActions: [], slots: [], commands: [], inspectorTabs: [], badges: {} });
});
afterEach(() => { cleanup(); usePluginRegistry.getState().unregister(ID); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Composer favorites settings', () => {
  it('shows the defaults as closed rows; a tap opens one row at a time', async () => {
    await open();
    expect(actions()).toHaveLength(8);
    expect(rows()).toHaveLength(8);
    expect(screen.queryByTestId('favorite-editor')).toBeNull();
    fireEvent.click(screen.getAllByTestId('favorite-head')[0]);
    expect(screen.getAllByTestId('favorite-editor')).toHaveLength(1);
    expect((screen.getByLabelText('Name of button 1') as HTMLInputElement).value).toBe('Summarize');
    fireEvent.click(screen.getAllByTestId('favorite-head')[2]);
    expect(screen.getAllByTestId('favorite-editor')).toHaveLength(1);
    expect((screen.getByLabelText('Name of button 3') as HTMLInputElement).value).toBe('Run tests');
    fireEvent.click(screen.getAllByTestId('favorite-head')[2]);
    expect(screen.queryByTestId('favorite-editor')).toBeNull();
  });

  it('writes an edit when the field loses focus, and the composer shows the new name', async () => {
    const daemon = await open();
    fireEvent.click(screen.getAllByTestId('favorite-head')[0]);
    const name = screen.getByLabelText('Name of button 1');
    fireEvent.change(name, { target: { value: 'Recap' } });
    expect(daemon.puts).toHaveLength(0);
    fireEvent.blur(name);
    await settle();
    expect(daemon.puts).toHaveLength(1);
    expect(daemon.puts[0][0]).toMatchObject({ id: 'summarize', label: 'Recap', mode: 'send' });
    expect(actions()[0]).toBe('Recap');
  });

  it('writes a typed edit when the row closes or the screen goes away', async () => {
    const daemon = await open();
    fireEvent.click(screen.getAllByTestId('favorite-head')[1]);
    fireEvent.change(screen.getByLabelText('Message of button 2'), { target: { value: 'Go on.' } });
    fireEvent.click(screen.getByText('Done'));
    await settle();
    expect(daemon.puts.at(-1)?.[1].text).toBe('Go on.');
    fireEvent.click(screen.getAllByTestId('favorite-head')[1]);
    fireEvent.change(screen.getByLabelText('Message of button 2'), { target: { value: 'Go on, please.' } });
    cleanup();
    await settle();
    expect(daemon.puts.at(-1)?.[1].text).toBe('Go on, please.');
  });

  it('changes the action at once', async () => {
    const daemon = await open();
    fireEvent.click(screen.getAllByTestId('favorite-head')[0]);
    fireEvent.click(within(screen.getByTestId('favorite-editor')).getByRole('radio', { name: 'Replace' }));
    await settle();
    expect(daemon.puts.at(-1)?.[0].mode).toBe('replace');
  });

  it('removes a button, and Undo brings it back', async () => {
    const daemon = await open();
    fireEvent.click(screen.getAllByTestId('favorite-head')[0]);
    fireEvent.click(screen.getByText('Remove'));
    await settle();
    expect(rows()).toHaveLength(7);
    expect(actions()).not.toContain('Summarize');
    expect(daemon.puts.at(-1)).toHaveLength(7);
    fireEvent.click(screen.getByText('Undo'));
    await settle();
    expect(rows()).toHaveLength(8);
    expect(actions()[0]).toBe('Summarize');
    expect(daemon.puts.at(-1)).toHaveLength(8);
  });

  it('adds an open, empty row that stays off the composer until it has a name and a message', async () => {
    const daemon = await open();
    fireEvent.click(screen.getByText('Add a button'));
    await settle();
    expect(rows()).toHaveLength(9);
    expect(actions()).toHaveLength(8);
    fireEvent.change(screen.getByLabelText('Name of button 9'), { target: { value: 'Ship it' } });
    const message = screen.getByLabelText('Message of button 9');
    fireEvent.change(message, { target: { value: 'Release this now.\n\nThen tell me the version.' } });
    fireEvent.blur(message);
    await settle();
    expect(actions().at(-1)).toBe('Ship it');
    expect(daemon.puts.at(-1)?.[8]).toMatchObject({ label: 'Ship it', mode: 'send' });
  });

  it('does not keep a new row that was closed with nothing in it, and writes nothing for it', async () => {
    const daemon = await open();
    fireEvent.click(screen.getByText('Add a button'));
    await settle();
    expect(rows()).toHaveLength(9);
    fireEvent.blur(screen.getByLabelText('Name of button 9'));
    fireEvent.click(screen.getByText('Done'));
    await settle();
    expect(rows()).toHaveLength(8);
    expect(daemon.puts).toHaveLength(0);
    expect(screen.queryByTestId('favorite-undo')).toBeNull();
  });

  it('keeps the Undo line when the app mounts the screen again', async () => {
    await open();
    fireEvent.click(screen.getAllByTestId('favorite-head')[0]);
    fireEvent.click(screen.getByText('Remove'));
    await settle();
    cleanup();
    const Settings = usePluginRegistry.getState().settings[0].Component as React.ComponentType;
    render(<Settings />);
    await settle();
    expect(rows()).toHaveLength(7);
    fireEvent.click(within(screen.getByTestId('favorite-undo')).getByText('Undo'));
    await settle();
    expect(rows()).toHaveLength(8);
    expect(screen.queryByTestId('favorite-undo')).toBeNull();
  });

  it('gives each row a grip that holds a finger, apart from the button that opens the row', async () => {
    await open();
    const grips = screen.getAllByTestId('favorite-grip');
    expect(grips).toHaveLength(8);
    expect(grips[0].style.touchAction).toBe('none');
    expect(grips[0].getAttribute('aria-label')).toBe('Move Summarize');
    expect(grips[0].contains(screen.getAllByTestId('favorite-head')[0])).toBe(false);
    fireEvent.click(grips[0]);
    expect(screen.queryByTestId('favorite-editor')).toBeNull();
  });

  it('keeps a list saved by version 0.1.0: each button adds its text', async () => {
    await open([{ label: 'Old one', text: 'first' }, { label: 'Old two', text: 'second' }]);
    expect(actions()).toEqual(['Old one', 'Old two']);
    expect(rows()).toHaveLength(2);
    expect(within(rows()[0]).getByText('Add')).toBeTruthy();
  });

  it('an app with no drag list moves a row with buttons', async () => {
    const sdk = createPluginSdk(ID);
    const daemon = await open(undefined, { ...sdk, ui: { ...sdk.ui, SortableList: undefined } });
    fireEvent.click(screen.getAllByTestId('favorite-head')[0]);
    fireEvent.click(screen.getByText('Move down'));
    await settle();
    expect(daemon.puts.at(-1)?.slice(0, 2).map((f) => f.id)).toEqual(['continue', 'summarize']);
    expect(actions().slice(0, 2)).toEqual(['Continue', 'Summarize']);
    expect(names().slice(0, 2)).toEqual(['Continue', 'Summarize']);
  });
});
