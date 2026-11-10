import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createPluginSdk } from './facade';
import { useProjects } from '../stores/projects';
// The bundled Previews plugin is plain JS.
import activate from '../../../plugins/previews/web.js';

// 2026-11-09: the Previews screen crashed on an iPhone with 74 previews. Every card loaded its
// full-size images and rendered its whole report at once. It now shows 20, then 20 more on request,
// so the page holds 20 sets of images at most.
const doc = (i: number) => ({
  id: `p${String(i).padStart(3, '0')}`, sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Perf',
  title: `Preview ${i}`, note: null, text: null,
  files: [{ fileId: `f${i}`, name: `shot-${i}.png`, mime: 'image/png', size: 1000 }],
  createdAt: new Date(Date.UTC(2026, 10, 9, 12, 0, 0) - i * 60_000).toISOString(), seenAt: 'seen',
});
const DOCS = Array.from({ length: 74 }, (_, i) => doc(i));

describe('the Previews screen with many previews', () => {
  let History: React.ComponentType;
  beforeEach(() => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }] as never });
    const base = createPluginSdk('previews');
    const views: { Component: React.ComponentType }[] = [];
    const d = {
      ...base,
      docs: { ...base.docs, entries: vi.fn(async () => DOCS.map((v) => ({ key: `preview:${v.id}`, value: v }))), set: vi.fn(async () => {}) },
      events: { on: () => () => {} },
      register: (c: { views: { Component: React.ComponentType }[] }) => { views.push(...c.views); },
    };
    activate(d as never);
    History = views[0].Component;
  });

  it('shows the newest 20 first, and Show older adds 20 at a time', async () => {
    render(<History />);
    await screen.findByText('Preview 0');
    expect(screen.queryByText('Preview 19')).not.toBeNull();
    expect(screen.queryByText('Preview 20')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show older/ }));
    expect(screen.queryByText('Preview 39')).not.toBeNull();
    expect(screen.queryByText('Preview 40')).toBeNull();
  });

  it('only the images of the shown page are in the page (no lazy loading: Safari never starts a lazy image in the sheet)', async () => {
    render(<History />);
    await screen.findByText('Preview 0');
    const imgs = Array.from(document.querySelectorAll('img'));
    expect(imgs.length).toBe(20);
    for (const img of imgs) expect(img.getAttribute('loading')).toBeNull();
    // A card shows a small copy; the full image opens only in the viewer.
    for (const img of imgs) expect(img.getAttribute('src')).toMatch(/\?thumb=480$/);
  });
});

describe('the project sheet with many previews', () => {
  it('opens, closes and opens again with no hook-order error, and pages by 20', async () => {
    const { act } = await import('@testing-library/react');
    useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }] as never });
    const base = createPluginSdk('previews');
    const slots: { slot: string; Component: React.ComponentType }[] = [];
    let api: { openSheet: (id: string) => void; closeSheet: () => void } | null = null;
    const d = {
      ...base,
      docs: { ...base.docs, entries: vi.fn(async () => DOCS.map((v) => ({ key: `preview:${v.id}`, value: v }))), set: vi.fn(async () => {}) },
      events: { on: () => () => {} },
      register: (c: { slots: { slot: string; Component: React.ComponentType }[]; projectMenu: { onPick: (a: unknown) => void }[] }) => {
        slots.push(...c.slots);
        api = { openSheet: (id) => c.projectMenu[0].onPick({ session: { id } }), closeSheet: () => {} };
      },
    };
    activate(d as never);
    const Sheet = slots.find((s) => s.slot === 'app.overlay')!.Component;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Sheet />);
    await act(async () => { api!.openSheet('s1'); });
    await screen.findByText('Preview 0');
    expect(screen.queryByText('Preview 20')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show older/ }));
    expect(screen.queryByText('Preview 39')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await act(async () => { api!.openSheet('s1'); });
    await screen.findByText('Preview 0');
    expect(errors.mock.calls.map((c) => String(c[0])).filter((m) => /hooks|Rendered (more|fewer)/i.test(m))).toEqual([]);
    errors.mockRestore();
  });
});
