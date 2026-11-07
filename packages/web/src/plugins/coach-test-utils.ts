import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { create } from 'zustand';
import { vi } from 'vitest';

/**
 * A fake plugin SDK for the Coach tests: documents and settings live in maps, events are
 * emitted by hand, and every action the Coach may call is a spy. The Coach reads only what
 * it is given, so a missing core feature (assist options, openSchedule) is tested by leaving
 * it out.
 */
export interface FakeD {
  id: string;
  docs: Map<string, unknown>;
  settingsValue: { current: unknown };
  registered: Record<string, Record<string, unknown[]>>;
  emit: (e: Record<string, unknown>) => void;
  hint: ReturnType<typeof vi.fn>;
  actions: Record<string, ReturnType<typeof vi.fn>>;
  assist: ReturnType<typeof vi.fn>;
  [k: string]: unknown;
}

export function fakeD(over: { actions?: Record<string, unknown>; settings?: unknown; docs?: Record<string, unknown> } = {}): FakeD {
  const docs = new Map<string, unknown>(Object.entries(over.docs ?? {}));
  const settingsValue = { current: over.settings ?? null as unknown };
  const registered: Record<string, Record<string, unknown[]>> = {};
  const listeners = new Map<string, Set<(e: Record<string, unknown>) => void>>();
  const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const h = React.createElement;
  const d = {
    id: 'coach',
    version: '1.0',
    React,
    h,
    Fragment: React.Fragment,
    hooks: { useState, useEffect, useMemo, useCallback, useRef, useIsMobile: () => false },
    zustand: { create },
    stores: { useProjects: create(() => ({ sessions: [{ id: 's1', name: 'Alpha' }, { id: 's2', name: 'Beta' }] })) },
    ui: {
      styles: { sectionLabel: {}, row: {}, item: {}, ghostBtn: {}, solidBtn: () => ({}), chip: {}, fieldInput: {} },
      Toggle: (p: { on: boolean; label: string; onClick: () => void }) => h('button', { role: 'switch', 'aria-checked': p.on, 'aria-label': p.label, onClick: p.onClick }),
    },
    storage: {
      get: async (_p: string, k: string, f: unknown) => (docs.has(k) ? clone(docs.get(k)) : f),
      set: async (_p: string, k: string, v: unknown) => { docs.set(k, clone(v)); },
      remove: async (_p: string, k: string) => { docs.delete(k); },
      list: async () => [...docs.keys()],
      all: async () => [...docs.entries()].map(([key, value]) => ({ key, value: clone(value) })),
    },
    settings: {
      get: async (_p: string, f: unknown) => clone(settingsValue.current ?? f),
      set: async (_p: string, v: unknown) => { settingsValue.current = clone(v); },
    },
    events: {
      on(type: string | string[], fn: (e: Record<string, unknown>) => void) {
        for (const t of Array.isArray(type) ? type : [type]) { const s = listeners.get(t) ?? new Set(); s.add(fn); listeners.set(t, s); }
        return () => { for (const s of listeners.values()) s.delete(fn); };
      },
    },
    emit(e: Record<string, unknown>) { for (const k of [String(e.type), '*']) for (const fn of listeners.get(k) ?? []) fn(e); },
    assist: vi.fn(),
    actions: { setView: vi.fn(), openSettings: vi.fn(), ...(over.actions ?? {}) },
    hint: vi.fn(),
    register: (id: string, c: Record<string, unknown[]>) => { registered[id] = c; },
    unregister: vi.fn(),
    docs,
    settingsValue,
    registered,
  };
  return d as unknown as FakeD;
}
