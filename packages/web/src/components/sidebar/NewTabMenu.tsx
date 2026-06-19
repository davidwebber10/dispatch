import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';

const TYPES: { type: string; label: string; config?: Record<string, unknown> }[] = [
  { type: 'claude-code', label: 'Claude Code' },
  { type: 'codex', label: 'Codex' },
  { type: 'shell', label: 'Terminal' },
];

export function NewTabMenu({ sessionId, onClose, onCreated }: { sessionId: string; onClose: () => void; onCreated?: (terminalId: string) => void }) {
  async function add(t: (typeof TYPES)[number]) {
    onClose();
    try {
      const term = await api.createTerminal(sessionId, { type: t.type, ...(t.config ? { config: t.config } : {}) });
      await useTabs.getState().loadTabs(sessionId);
      onCreated?.(term.id);
    } catch { /* surfaced via connection state */ }
  }
  return (
    <>
      <div onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 22, left: 0, zIndex: 91, minWidth: 150, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
        <div style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', padding: '4px 8px' }}>NEW</div>
        {TYPES.map((t) => (
          <button key={t.type} onClick={() => void add(t)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>{t.label}</button>
        ))}
      </div>
    </>
  );
}
