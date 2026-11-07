import { useEffect, useMemo, useRef, useState } from 'react';
import { useUI, type View } from '../stores/ui';
import { useContributions } from '../plugins/registry';
import { SETTINGS_SECTIONS } from './settings/sections';
import { primaryMod } from '../lib/hostkeys';

/**
 * The command palette (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2; plugins
 * slice 6): ⌘K / Ctrl+K on the desktop. The built-in rows open a view or a settings section;
 * plugins add rows through the `commands` contribution. Typing filters; Enter runs the first
 * match; Escape closes.
 */
interface Row { key: string; label: string; hint: string; run: () => void }

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const pluginCommands = useContributions('commands');
  const rows = useMemo<Row[]>(() => [
    ...([['workspace', 'Threads'], ['chat', 'Chat'], ['analytics', 'Analytics'], ['settings', 'Settings']] as [View, string][]).map(([view, label]) => ({ key: `view:${view}`, label, hint: 'View', run: () => useUI.getState().setView(view) })),
    ...SETTINGS_SECTIONS.map((s) => ({ key: `settings:${s.key}`, label: s.label, hint: 'Settings', run: () => useUI.getState().requestSettings(s.key) })),
    ...pluginCommands.map((c) => ({ key: `plugin:${c.plugin}:${c.id}`, label: c.label, hint: c.plugin, run: c.run })),
  ], [pluginCommands]);
  const shown = useMemo(() => { const needle = q.trim().toLowerCase(); return needle ? rows.filter((r) => r.label.toLowerCase().includes(needle)) : rows; }, [rows, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!primaryMod(e) || e.key.toLowerCase() !== 'k') return;
      // Inside a terminal the key belongs to the shell (^K) — never both.
      if (document.activeElement?.closest?.('.xterm')) return;
      e.preventDefault(); setOpen((o) => !o); setQ(''); setCursor(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  if (!open) return null;

  const pick = (r: Row) => { setOpen(false); try { r.run(); } catch (e) { console.error('[command]', e); } };
  return (
    <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'var(--color-overlay)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh' }}>
      <div role="dialog" aria-modal="true" aria-label="Commands" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 92vw)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xl)', boxShadow: '0 20px 60px var(--color-shadow)', overflow: 'hidden' }}>
        <input ref={input} role="combobox" aria-label="Command" aria-expanded="true" aria-controls="command-list" value={q} placeholder="Type a command…"
          onChange={(e) => { setQ(e.target.value); setCursor(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, shown.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); const r = shown[cursor]; if (r) pick(r); }
          }}
          style={{ width: '100%', boxSizing: 'border-box', padding: '14px 16px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-primary)', fontSize: 15, outline: 'none' }} />
        <ul id="command-list" role="listbox" style={{ listStyle: 'none', margin: 0, padding: 6, maxHeight: '50vh', overflowY: 'auto' }}>
          {shown.length === 0 && <li style={{ padding: '10px 12px', fontSize: 13, color: 'var(--color-text-tertiary)' }}>No command matches.</li>}
          {shown.map((r, i) => (
            <li key={r.key} role="option" aria-label={r.label} aria-selected={i === cursor} onMouseEnter={() => setCursor(i)} onClick={() => pick(r)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', background: i === cursor ? 'var(--color-elevated)' : 'transparent', color: 'var(--color-text-primary)', fontSize: 14 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
              <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{r.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
