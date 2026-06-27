import type { ConvItem, TodoItem } from '../../../api/types';

const GLYPH: Record<string, string> = { completed: '✓', in_progress: '◐', pending: '○' };

export function TodoView({ tool }: { tool: ConvItem }) {
  let todos: TodoItem[] = [];
  try { const v = JSON.parse(tool.toolInput ?? '{}'); if (Array.isArray(v.todos)) todos = v.todos; } catch { /* empty */ }
  if (!todos.length) return <div style={{ padding: '9px 11px', color: 'var(--color-text-tertiary)', fontSize: 12 }}>No items.</div>;
  return (
    <div style={{ padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {todos.map((t, i) => {
        const done = t.status === 'completed';
        const active = t.status === 'in_progress';
        const text = active && t.activeForm ? t.activeForm : t.content;
        return (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, color: done ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)' }}>
            <span style={{ flexShrink: 0, color: active ? 'var(--color-accent)' : done ? 'var(--color-status-green, #5fce7e)' : 'var(--color-text-tertiary)' }}>{GLYPH[t.status] ?? '○'}</span>
            <span style={{ textDecoration: done ? 'line-through' : 'none', fontWeight: active ? 600 : 400 }}>{text}</span>
          </div>
        );
      })}
    </div>
  );
}
