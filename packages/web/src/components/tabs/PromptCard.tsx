import { api } from '../../api/client';
import { usePrompts } from '../../stores/prompts';
import { useThreadMode } from '../../stores/threadMode';
import { TerminalTab } from './TerminalTab';

/**
 * Surfaces a detected interactive prompt inside Visual mode: clean option
 * buttons when the prompt was parsed, or an inline live terminal (never-stuck
 * fallback) when it wasn't. "Answer in terminal" flips the tab to Terminal mode.
 */
export function PromptCard({ terminalId }: { terminalId: string }) {
  const prompt = usePrompts((s) => s.byTerminal[terminalId]);
  if (!prompt) return null;

  const clearOptimistic = () => usePrompts.setState((s) => ({ byTerminal: { ...s.byTerminal, [terminalId]: null } }));
  const choose = (keys: string) => { void api.sendInput(terminalId, keys); clearOptimistic(); };
  const toTerminal = () => useThreadMode.getState().set(terminalId, 'expert');

  if (!prompt.parsed) {
    return (
      <div style={{ border: '1px solid var(--color-status-yellow)', borderRadius: 10, overflow: 'hidden', margin: '4px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', font: '500 12px var(--font-sans)', color: 'var(--color-status-yellow)', background: 'rgba(245,197,66,.08)' }}>
          <span>The agent is asking — answer below</span>
          <button onClick={toTerminal} style={linkBtn}>Open full terminal</button>
        </div>
        <div style={{ height: 200 }}><TerminalTab terminalId={terminalId} /></div>
      </div>
    );
  }

  return (
    <div style={{ border: '1px solid var(--color-status-yellow)', borderRadius: 10, padding: '10px 12px', margin: '4px 0', background: 'rgba(245,197,66,.06)' }}>
      <div style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--color-text-primary)', marginBottom: 9 }}>{prompt.question}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {prompt.options.map((o, i) => (
          <button key={i} onClick={() => choose(o.keys)} style={{
            padding: '5px 13px', borderRadius: 7, border: i === 0 ? 'none' : '1px solid #2c2c32', cursor: 'pointer',
            background: i === 0 ? 'var(--color-accent)' : 'var(--color-elevated)',
            color: i === 0 ? '#08240F' : 'var(--color-text-primary)', fontSize: 12.5, fontWeight: 500,
          }}>{o.label}</button>
        ))}
        <button onClick={toTerminal} title="Switch to Terminal mode to answer manually" style={{ ...linkBtn, marginLeft: 'auto' }}>Answer in terminal</button>
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 11.5 };
