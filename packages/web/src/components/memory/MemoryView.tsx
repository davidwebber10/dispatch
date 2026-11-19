import { useEffect } from 'react';
import { Brain, FolderSimple, UserCircle } from '@phosphor-icons/react';
import { useMemory } from '../../stores/memory';
import { Select } from '../common/Select';
import { SettingsGroup, SettingsRow, noteText } from '../settings/ui';
import { MemoryScopePanel, MemorySwitches, MemoryOffPanel } from './MemoryScopePanel';
import { fontVar } from '../../lib/fontSize';

/**
 * The Memory view (docs/superpowers/specs/2026-11-17-memory-design.md, part 5): two panes, the shape
 * of Settings. Left: the scopes (You, then each project) and the switches. Right: the scope.
 */
export function MemoryView() {
  const scopes = useMemory((s) => s.scopes);
  const scope = useMemory((s) => s.scope);
  const error = useMemory((s) => s.error);
  useEffect(() => { void useMemory.getState().load(); }, []);
  const active = scopes?.find((s) => s.scope === scope);
  const settings = useMemory((s) => s.settings);
  // Off (the default): only the switch, as in Settings > Memory.
  if (settings && !settings.enabled) {
    return (
      <div data-testid="memory-view" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '22px 22px 48px', background: 'var(--color-base)' }}>
        <div style={{ maxWidth: 860 }}><MemoryOffPanel /></div>
      </div>
    );
  }

  return (
    <div data-testid="memory-view" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden', background: 'var(--color-base)' }}>
      <div role="navigation" aria-label="Memory scopes" style={{ width: 214, flexShrink: 0, background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderBottom: '1px solid var(--color-border)' }}>
          <Brain aria-hidden size={15} color="var(--color-text-tertiary)" />
          <span style={{ fontSize: fontVar(13), fontWeight: 600, color: 'var(--color-text-primary)' }}>Memory</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 8px' }}>
          <div style={{ font: `500 ${fontVar(9.5)} var(--font-mono)`, letterSpacing: '0.1em', color: 'var(--color-text-tertiary)', padding: '2px 8px 6px' }}>SCOPE</div>
          {scopes?.map((s) => {
            const on = s.scope === scope;
            const Icon = s.projectId ? FolderSimple : UserCircle;
            const count = s.pages + s.newNotes;
            return (
              <button key={s.scope} type="button" onClick={() => useMemory.getState().setScope(s.scope)} aria-current={on ? 'page' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '6px 8px', marginBottom: 1,
                  borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer', textAlign: 'left',
                  background: on ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'transparent',
                  opacity: s.remembered ? 1 : 0.6,
                }}>
                <Icon aria-hidden size={15} weight={on ? 'fill' : 'regular'} color={on ? 'var(--color-accent)' : 'var(--color-text-tertiary)'} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: fontVar(12.5), fontWeight: on ? 500 : 400, color: on ? 'var(--color-text-primary)' : 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                {count > 0 && <span style={{ font: `400 ${fontVar(10.5)} var(--font-mono)`, color: 'var(--color-text-tertiary)' }}>{count}</span>}
              </button>
            );
          })}
        </div>
        <div style={{ borderTop: '1px solid var(--color-border)', padding: 8, flexShrink: 0 }}>
          <MemorySwitches />
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 22px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
          <h1 style={{ margin: 0, fontSize: fontVar(14), fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active?.label ?? 'Memory'}</h1>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 22px 48px' }}>
          <div style={{ maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {error && <div role="alert" style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)' }}>{error}</div>}
            {scopes && <MemoryScopePanel key={scope} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings → Memory: the same memory in one column, for the phone (its bottom bar is full, spec 5.1).
 * On a desktop it is the same screen as the Memory view, in the Settings frame.
 */
export function MemorySection() {
  const scopes = useMemory((s) => s.scopes);
  const scope = useMemory((s) => s.scope);
  const error = useMemory((s) => s.error);
  const settings = useMemory((s) => s.settings);
  useEffect(() => { void useMemory.getState().load(); }, []);
  if (settings && !settings.enabled) return <MemoryOffPanel />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={noteText}>What threads keep between threads: about you, and about each project. Threads search it and save notes to it; you edit it here.</div>
      <MemorySwitches />
      {scopes && (
        <SettingsGroup>
          <SettingsRow label="Scope" control={<Select ariaLabel="Scope" value={scope} onChange={(v) => useMemory.getState().setScope(v)} style={{ width: 180 }}
            options={scopes.map((s) => ({ value: s.scope, label: s.label }))} />} />
        </SettingsGroup>
      )}
      {error && <div role="alert" style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)' }}>{error}</div>}
      {scopes && <MemoryScopePanel key={scope} />}
    </div>
  );
}
