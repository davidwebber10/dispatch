import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { create } from 'zustand';
import { vi } from 'vitest';
import * as Icons from '@phosphor-icons/react';
import { Select } from '../components/common/Select';
import { MultiSelect } from '../components/common/MultiSelect';
import { Segmented } from '../components/common/Segmented';
import { SettingsGroup, SettingsRow } from '../components/settings/ui';

/**
 * A fake plugin SDK, version 2 (the bound object of facade.ts: no plugin id in any call, no `api`,
 * no `stores`), for the Coach tests: documents and settings live in maps, events are
 * emitted by hand, and every action the Coach may call is a spy. The Coach reads only what
 * it is given, so a missing core feature (assist options, openSchedule) is tested by leaving
 * it out.
 */
export interface FakeD {
  /** The fake version 2 object: pass this to `createCoach`. */
  sdk: unknown;
  id: string;
  docs: Map<string, unknown>;
  settingsValue: { current: unknown };
  registered: Record<string, Record<string, unknown[]>>;
  emit: (e: Record<string, unknown>) => void;
  hint: ReturnType<typeof vi.fn>;
  actions: Record<string, ReturnType<typeof vi.fn>>;
  /** The bound model calls (`d.model`): usage, share, budget, setBudget. */
  model: Record<string, ReturnType<typeof vi.fn>>;
  plugin: { disable: ReturnType<typeof vi.fn> };
  /** The same spies as `ui.hint` and `ui.copyText`, for the assertions. */
  copyText: ReturnType<typeof vi.fn>;
  assist: ReturnType<typeof vi.fn>;
  [k: string]: unknown;
}

export function fakeD(over: { actions?: Record<string, unknown>; settings?: unknown; docs?: Record<string, unknown>; model?: Record<string, unknown>; mobile?: boolean } = {}): FakeD {
  const docs = new Map<string, unknown>(Object.entries(over.docs ?? {}));
  const settingsValue = { current: over.settings ?? null as unknown };
  const registered: Record<string, Record<string, unknown[]>> = {};
  const listeners = new Map<string, Set<(e: Record<string, unknown>) => void>>();
  const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const h = React.createElement;
  const hint = vi.fn();
  const copyText = vi.fn(async () => {});
  const projects = [{ id: 's1', name: 'Alpha', workingDir: '/a', archived: false }, { id: 's2', name: 'Beta', workingDir: '/b', archived: false }];
  const d = {
    id: 'coach',
    version: 2,
    React,
    h,
    Fragment: React.Fragment,
    hooks: { useState, useEffect, useMemo, useCallback, useRef, useIsMobile: () => !!over.mobile, useProjects: () => projects },
    zustand: { create },
    // The names the SDK's icon map gives (sdk.tsx ICONS).
    icons: { x: Icons.X, 'thumbs-up': Icons.ThumbsUp, 'thumbs-down': Icons.ThumbsDown, dots: Icons.DotsThree, 'bell-slash': Icons.BellSlash, sparkle: Icons.Sparkle, 'arrow-up': Icons.ArrowUp, 'arrow-down': Icons.ArrowDown, 'arrow-right': Icons.ArrowRight, target: Icons.Target, plus: Icons.Plus, gear: Icons.Gear, 'caret-down': Icons.CaretDown, 'caret-right': Icons.CaretRight },
    ui: {
      hint, copyText,
      styles: { sectionLabel: {}, row: {}, item: {}, ghostBtn: {}, solidBtn: () => ({}), chip: {}, fieldInput: {} },
      Toggle: (p: { on: boolean; label: string; onClick: () => void }) => h('button', { role: 'switch', 'aria-checked': p.on, 'aria-label': p.label, onClick: p.onClick }),
      // The real shared dropdown: the Coach has no native select (2026-11-07).
      Select,
      // The real settings primitives (coach settings cleanup, 2026-11-07).
      MultiSelect, Segmented, SettingsGroup, SettingsRow,
    },
    docs: {
      get: async (k: string, f: unknown) => (docs.has(k) ? clone(docs.get(k)) : f),
      set: async (k: string, v: unknown) => { docs.set(k, clone(v)); },
      delete: async (k: string) => { docs.delete(k); },
      keys: async () => [...docs.keys()],
      entries: async () => [...docs.entries()].map(([key, value]) => ({ key, value: clone(value) })),
    },
    settings: {
      get: async (f?: unknown) => clone(settingsValue.current ?? f ?? null),
      set: async (v: unknown) => { settingsValue.current = clone(v); },
    },
    events: {
      on(type: string | string[], fn: (e: Record<string, unknown>) => void) {
        for (const t of Array.isArray(type) ? type : [type]) { const s = listeners.get(t) ?? new Set(); s.add(fn); listeners.set(t, s); }
        return () => { for (const s of listeners.values()) s.delete(fn); };
      },
    },
    emit(e: Record<string, unknown>) { for (const k of [String(e.type), '*']) for (const fn of listeners.get(k) ?? []) fn(e); },
    assist: vi.fn(),
    actions: { setView: vi.fn(), openSettings: vi.fn(), setBadge: vi.fn(), ...(over.actions ?? {}) },
    // The plugin's own cost and budget: the Coach reads them and writes its budget through `d.model`.
    model: {
      usage: vi.fn(async () => ({ calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, byModel: [] })),
      share: vi.fn(async () => ({ fiveHour: null, sevenDay: null })),
      budget: vi.fn(async () => ({ percentWeekly: 3, usdWeekly: 5 })),
      setBudget: vi.fn(async (b: Record<string, unknown>) => ({ percentWeekly: 3, usdWeekly: 5, ...b })),
      ...(over.model ?? {}),
    },
    plugin: { disable: vi.fn(async () => {}) },
    register: (c: Record<string, unknown[]>) => { registered.coach = c; },
  };
  // The test's handle: `sdk` is what the Coach gets (`createCoach(d.sdk)`). On the handle, `docs` is the
  // map behind the SDK's documents; every other member (actions, assist, model, emit, …) is the SDK's own.
  return Object.assign(Object.create(d), { docs, settingsValue, registered, hint, copyText, sdk: d }) as unknown as FakeD;
}
