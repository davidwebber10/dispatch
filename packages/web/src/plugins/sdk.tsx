import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import * as Icons from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { api } from '../api/client';
import { useUI } from '../stores/ui';
import { useProjects } from '../stores/projects';
import { useTabs } from '../stores/tabs';
import { usePreviews } from '../stores/previews';
import { useUpdate } from '../stores/update';
import { useThreadStatus } from '../stores/threadStatus';
import { useHint } from '../stores/hint';
import { useIsMobile } from '../hooks/useIsMobile';
import { Modal } from '../components/common/Modal';
import { Markdown } from '../components/Markdown';
import { FileViewer } from '../components/viewer/FileViewer';
import { copyText } from '../lib/clipboard';
import { openThreadInPlace } from '../components/endless/openThread';
import { sectionLabel, row, item, ghostBtn, solidBtn, chip, fieldInput, Toggle } from '../components/settings/ui';
import { usePluginRegistry, useContributions, type Contributions } from './registry';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.2): the object a plugin's
 * bundle finds at `window.dispatch`. A bundle ships no React or zustand; it uses the app's through
 * this object, so its screens share the app's React tree, styles and stores. `register` is the
 * one write; everything else is what the app already has.
 */
export const SDK_VERSION = '1.0';

const ICONS: Record<string, Icon> = {
  puzzle: Icons.PuzzlePiece, sun: Icons.Sun, star: Icons.Star, sparkle: Icons.Sparkle, lightning: Icons.Lightning,
  calendar: Icons.Calendar, clock: Icons.Clock, note: Icons.Note, rocket: Icons.Rocket, flag: Icons.Flag, heart: Icons.Heart,
  folder: Icons.Folder, terminal: Icons.TerminalWindow, git: Icons.GitBranch, cloud: Icons.Cloud, database: Icons.Database,
  bell: Icons.Bell, chart: Icons.ChartBar, list: Icons.ListChecks, play: Icons.Play, gear: Icons.Gear, eye: Icons.Eye,
  chat: Icons.ChatCircleDots, book: Icons.BookOpen, bug: Icons.Bug, shield: Icons.ShieldCheck, globe: Icons.Globe, wrench: Icons.Wrench,
};
export const pluginIcon = (name: string | undefined): Icon => (name && ICONS[name]) || Icons.PuzzlePiece;

/** Per-plugin key-value storage. localStorage in this slice; slice 2 moves it to the daemon. */
const storage = {
  get<T = unknown>(plugin: string, key: string, fallback: T): T {
    try { const raw = localStorage.getItem(`dispatch:plugin:${plugin}:${key}`); return raw === null ? fallback : (JSON.parse(raw) as T); } catch { return fallback; }
  },
  set(plugin: string, key: string, value: unknown): void {
    try { localStorage.setItem(`dispatch:plugin:${plugin}:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
  remove(plugin: string, key: string): void {
    try { localStorage.removeItem(`dispatch:plugin:${plugin}:${key}`); } catch { /* ignore */ }
  },
  list(plugin: string): string[] {
    const prefix = `dispatch:plugin:${plugin}:`;
    const out: string[] = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(prefix)) out.push(k.slice(prefix.length)); } } catch { /* ignore */ }
    return out.sort();
  },
};

export interface DispatchSdk {
  version: string;
  React: typeof React;
  h: typeof React.createElement;
  Fragment: typeof React.Fragment;
  hooks: {
    useState: typeof useState; useEffect: typeof useEffect; useMemo: typeof useMemo; useCallback: typeof useCallback; useRef: typeof useRef;
    useIsMobile: typeof useIsMobile; useContributions: typeof useContributions;
    /** Read a store with a selector; memoise an array-returning selector yourself, or use useContributions. */
    useStore: <S, T>(store: UseBoundStore<StoreApi<S>>, selector: (s: S) => T) => T;
  };
  zustand: { create: typeof create };
  stores: { useUI: typeof useUI; useProjects: typeof useProjects; useTabs: typeof useTabs; usePreviews: typeof usePreviews; useUpdate: typeof useUpdate; useThreadStatus: typeof useThreadStatus };
  actions: { setView: (key: string) => void; openThread: (projectId: string, terminalId: string) => Promise<void>; openSettings: (sectionKey: string) => void };
  api: typeof api;
  ui: { Modal: typeof Modal; Markdown: typeof Markdown; FileViewer: typeof FileViewer; Toggle: typeof Toggle; styles: { sectionLabel: React.CSSProperties; row: React.CSSProperties; item: React.CSSProperties; ghostBtn: React.CSSProperties; solidBtn: typeof solidBtn; chip: React.CSSProperties; fieldInput: React.CSSProperties } };
  icons: Record<string, Icon>;
  storage: typeof storage;
  hint: (msg: string) => void;
  copyText: (text: string) => Promise<void>;
  register: (plugin: string, c: Contributions) => void;
  unregister: (plugin: string) => void;
}

export function buildSdk(): DispatchSdk {
  return {
    version: SDK_VERSION,
    React,
    h: React.createElement,
    Fragment: React.Fragment,
    hooks: {
      useState, useEffect, useMemo, useCallback, useRef, useIsMobile, useContributions,
      useStore: (store, selector) => store(selector),
    },
    zustand: { create },
    stores: { useUI, useProjects, useTabs, usePreviews, useUpdate, useThreadStatus },
    actions: {
      setView: (key) => useUI.getState().setView(key as never),
      openThread: (projectId, terminalId) => openThreadInPlace(projectId, terminalId),
      openSettings: (sectionKey) => useUI.getState().requestSettings(sectionKey),
    },
    api,
    ui: { Modal, Markdown, FileViewer, Toggle, styles: { sectionLabel, row, item, ghostBtn, solidBtn, chip, fieldInput } },
    icons: ICONS,
    storage,
    hint: (msg) => useHint.getState().show(msg),
    copyText,
    register: (plugin, c) => usePluginRegistry.getState().register(plugin, c),
    unregister: (plugin) => usePluginRegistry.getState().unregister(plugin),
  };
}

declare global { interface Window { dispatch?: DispatchSdk } }

/** The one SDK object; built on first use and kept for the life of the page. */
export function installSdk(): DispatchSdk {
  if (!window.dispatch) window.dispatch = buildSdk();
  return window.dispatch;
}
