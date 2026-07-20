import { CaretRight, Wrench, FileText } from '@phosphor-icons/react';
import type { ConvItem } from '../../api/types';
import { highlightCode, langFromPath } from '../../lib/markdown';
import { getToolView, parseToolInput } from './toolviews/registry';
import { useToolExpanded, useToolTab } from '../../hooks/useToolUIState';

/** A tool call: single-line summary; expand to an Input/Output tabbed, syntax-
 *  highlighted shelf. If it references a file, the shelf offers "View file".
 *  Recognized tools (query, edit, todo, web) get a rich body via the registry;
 *  everything else falls back to the generic Input/Output panel. */
export function ToolCall({ tool, result, onViewFile }: { tool: ConvItem; result?: ConvItem; onViewFile?: (path: string) => void }) {
  // Keyed by the tool's OWN stable id (never the paired result's) — see useToolUIState's
  // doc comment for why this must survive a remount instead of living in plain useState.
  const id = tool.uuid ?? tool.toolId;
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
  const headerIcon = view?.icon ?? <Wrench size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />;
  const headerName = view?.label?.(tool) ?? name;
  const expandable = hasIn || hasOut;
  const effTab: 'input' | 'output' = (tab === 'input' && hasIn) ? 'input' : (hasOut ? 'output' : 'input');
  const content = effTab === 'input' ? input : out;
  const lang = effTab === 'input' ? (tool.toolName === 'Bash' ? 'bash' : 'json') : langFromPath(tool.toolFile);
  return (
    <div style={{ borderRadius: 9, overflow: 'hidden' }}>
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: expandable ? 'pointer' : 'default', padding: '4px 6px', borderRadius: 7, display: 'flex', gap: 7, alignItems: 'center' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
      >
        <CaretRight size={11} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)', visibility: expandable ? 'visible' : 'hidden', transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
        {headerIcon}
        <span style={{ minWidth: 0, flex: '0 1 auto', fontSize: 12.5, color: 'var(--color-text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerName}</span>
        {tool.toolDetail && (
          <span
            title={tool.toolDetail}
            style={{ minWidth: 0, flex: '1 1 auto', fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {tool.toolDetail}
          </span>
        )}
        {result
          ? <span style={{ flexShrink: 0, fontSize: 11, color: err ? 'var(--color-status-red)' : 'var(--color-text-secondary)' }}>{err ? 'error' : `${lines} line${lines !== 1 ? 's' : ''}`}</span>
          : <span className="chat-shimmer" style={{ flexShrink: 0, fontSize: 11 }}>running…</span>}
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
