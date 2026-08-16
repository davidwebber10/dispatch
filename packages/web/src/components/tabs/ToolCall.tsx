import { CaretRight, FileText } from '@phosphor-icons/react';
import type { ConvItem } from '../../api/types';
import { highlightCode, langFromPath } from '../../lib/markdown';
import { getToolView, parseToolInput } from './toolviews/registry';
import { useToolExpanded, useToolTab } from '../../hooks/useToolUIState';

/**
 * One mono glyph per tool family (2026-08-16 pretty-chat redesign): the leading column of a
 * machinery row identifies the KIND of call at a glance — $ shell, ≡ read, ✎ edit, ⌕ search,
 * ◇ subagent, ⚙ everything else — the way a prompt char identifies a terminal line.
 */
export function toolGlyph(name?: string): string {
  const n = (name ?? '').toLowerCase();
  if (n === 'bash' || n.endsWith('shell') || n === 'run_terminal_command') return '$';
  if (n === 'read' || n === 'notebookread' || n === 'read_file') return '≡';
  if (n === 'edit' || n === 'write' || n === 'notebookedit' || n === 'search_replace' || n === 'multiedit') return '✎';
  if (n === 'grep' || n === 'glob' || n === 'websearch' || n.includes('search')) return '⌕';
  if (n === 'task' || n === 'agent') return '◇';
  return '⚙';
}

/**
 * Best-effort +added −removed for an Edit/Write/MultiEdit input, for the row's right meta —
 * the design's `+33 −9`. Line counts of new_string vs old_string; a Write is all additions.
 * Null for anything unparseable: the meta then falls back to output lines, never a fake stat.
 */
export function editDiffStat(toolName?: string, toolInput?: string): { add: number; del: number } | null {
  const n = (toolName ?? '').toLowerCase();
  if (!['edit', 'write', 'notebookedit', 'multiedit'].includes(n) || !toolInput) return null;
  try {
    const p = JSON.parse(toolInput) as { old_string?: string; new_string?: string; content?: string; edits?: { old_string?: string; new_string?: string }[] };
    const count = (s?: string) => (s ? s.split('\n').length : 0);
    if (n === 'write') return p.content !== undefined ? { add: count(p.content), del: 0 } : null;
    const edits = Array.isArray(p.edits) ? p.edits : [{ old_string: p.old_string, new_string: p.new_string }];
    let add = 0;
    let del = 0;
    for (const e of edits) {
      if (e.old_string === undefined && e.new_string === undefined) return null;
      add += count(e.new_string);
      del += count(e.old_string);
    }
    return { add, del };
  } catch {
    return null;
  }
}

/** A tool call: single-line summary; expand to an Input/Output tabbed, syntax-
 *  highlighted shelf. If it references a file, the shelf offers "View file".
 *  Recognized tools (query, edit, todo, web) get a rich body via the registry;
 *  everything else falls back to the generic Input/Output panel. */
export function ToolCall({ tool, result, onViewFile }: { tool: ConvItem; result?: ConvItem; onViewFile?: (path: string) => void }) {
  // Keyed by the tool's OWN stable id (never the paired result's) — see useToolUIState's
  // doc comment for why this must survive a remount instead of living in plain useState.
  // `toolId ?? uuid` (not the reverse): useStructuredChat upgrades EVERY content block of
  // an assistant message to that message's single `uuid` once the whole-message event
  // lands, so in a settled message with parallel tool calls every ToolCall would otherwise
  // share one expansion key — expanding one expands all of them, including members of
  // sibling ToolGroups (which key off `toolId ?? uuid` for the same reason).
  const id = tool.toolId ?? tool.uuid;
  const [open, setOpen] = useToolExpanded(id, false);
  const [tab, setTab] = useToolTab(id, 'output');
  const name = tool.toolTitle ?? tool.toolName ?? 'Tool';
  const input = tool.toolInput ?? '';
  const out = result?.text ?? '';
  const hasIn = !!input.trim();
  const hasOut = !!out.trim();
  const err = result?.isError;
  const lines = hasOut ? out.split('\n').length : 0;
  const view = getToolView(tool.toolName, parseToolInput(tool.toolInput));
  const headerName = view?.label?.(tool) ?? name;
  const expandable = hasIn || hasOut;
  const effTab: 'input' | 'output' = (tab === 'input' && hasIn) ? 'input' : (hasOut ? 'output' : 'input');
  const content = effTab === 'input' ? input : out;
  const lang = effTab === 'input' ? (tool.toolName === 'Bash' ? 'bash' : 'json') : langFromPath(tool.toolFile);
  const diff = editDiffStat(tool.toolName, tool.toolInput);
  // Right meta priority: error > running > edit diff stat > output line count.
  const meta = result
    ? err
      ? { text: 'error', color: 'var(--color-status-red)' }
      : diff
      ? { text: `+${diff.add} −${diff.del}`, color: '#8fb79a' }
      : { text: `${lines} line${lines !== 1 ? 's' : ''}`, color: 'var(--color-text-tertiary)' }
    : null;
  return (
    <div style={{ overflow: 'hidden' }}>
      {/* Machinery row (2026-08-16 redesign): 30px mono line — caret · glyph · name · arg ·
          meta — reading like terminal output rather than a card. Expansion behavior and the
          shelf below are unchanged. */}
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: expandable ? 'pointer' : 'default', padding: 0, height: 30, display: 'flex', gap: 10, alignItems: 'center' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
      >
        <span style={{ width: 20, flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 0 }}>
          {expandable
            ? <CaretRight size={10} weight="bold" style={{ color: 'var(--color-text-tertiary)', transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
            : <span aria-hidden style={{ font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{toolGlyph(tool.toolName)}</span>}
        </span>
        {/* flexShrink 0: the name is the single most identifying thing on the row and is almost
            always short, so it never shrinks; the arg detail is the elastic half. maxWidth caps
            the pathological case (a very long MCP tool name). */}
        <span style={{ minWidth: 0, maxWidth: '55%', flexShrink: 0, font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerName}</span>
        {tool.toolDetail && (
          <span
            title={tool.toolDetail}
            style={{ minWidth: 0, flex: '1 1 auto', font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {tool.toolDetail}
          </span>
        )}
        {/* marginLeft:auto, not a flex-grow sibling — plenty of tools populate no detail at all,
            and without this the meta would wander instead of right-aligning. */}
        {meta
          ? <span style={{ marginLeft: 'auto', flexShrink: 0, font: '400 11px var(--font-mono)', color: meta.color }}>{meta.text}</span>
          : <span className="chat-shimmer" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11 }}>running…</span>}
      </button>
      {open && expandable && (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-elevated)', overflow: 'hidden', marginTop: 4 }}>
          {view ? view.expanded(tool, result) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 8px 0', background: 'var(--color-pane)' }}>
                {hasIn && <TabButton active={effTab === 'input'} onClick={() => setTab('input')}>Input</TabButton>}
                {hasOut && <TabButton active={effTab === 'output'} onClick={() => setTab('output')}>Output</TabButton>}
                {tool.toolFile && onViewFile && (
                  <button
                    onClick={() => onViewFile(tool.toolFile!)}
                    title={tool.toolFile}
                    style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: 'var(--color-accent)', font: '500 11.5px var(--font-sans)', cursor: 'pointer', padding: '3px 4px' }}
                  >
                    <FileText size={13} weight="bold" /> View file
                  </button>
                )}
              </div>
              <pre className="hljs" style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, padding: '9px 11px', maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                <code dangerouslySetInnerHTML={{ __html: highlightCode(content, lang) }} />
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 11px', fontSize: 11.5, borderRadius: '6px 6px 0 0', border: 'none', cursor: 'pointer',
      background: active ? 'var(--color-elevated)' : 'transparent', color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: active ? 600 : 400,
    }}>{children}</button>
  );
}

/** A tool result, minimized to a one-line summary and expandable on click. */
export function ToolResult({ item }: { item: ConvItem }) {
  const [open, setOpen] = useToolExpanded(item.uuid ?? item.toolId, false);
  const text = item.text ?? '';
  if (!text.trim()) return null;
  const lines = text.split('\n').length;
  const err = item.isError;
  const color = err ? 'var(--color-status-red)' : 'var(--color-text-secondary)';
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: '1px 0', font: '400 11.5px var(--font-mono)', color }}
      >
        <CaretRight size={10} weight="bold" style={{ transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
        {err ? 'Error output' : 'Output'}<span style={{ opacity: 0.6 }}> · {lines} line{lines !== 1 ? 's' : ''}</span>
      </button>
      {open && (
        <pre style={{ margin: '4px 0 0', font: '400 11.5px var(--font-mono)', lineHeight: 1.5, color, background: 'var(--color-elevated)', border: `1px solid ${err ? 'rgba(240,97,109,.3)' : 'var(--color-border)'}`, borderRadius: 8, padding: '8px 10px', maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</pre>
      )}
    </div>
  );
}
