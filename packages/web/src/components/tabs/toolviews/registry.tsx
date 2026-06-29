import type { ConvItem } from '../../../api/types';
import { Database, PencilSimple, ListChecks, Globe } from '@phosphor-icons/react';
import { QueryView } from './QueryView';
import { DiffView } from './DiffView';
import { TodoView } from './TodoView';
import { WebView } from './WebView';

export interface ToolView {
  icon?: React.ReactNode;
  label?: (tool: ConvItem) => string;
  expanded: (tool: ConvItem, result: ConvItem | undefined) => React.ReactNode;
}

export function parseToolInput(toolInput: string | undefined): any {
  if (!toolInput) return null;
  try { const v = JSON.parse(toolInput); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

function hasQuery(input: any): boolean {
  return !!input && (typeof input.query === 'string' || typeof input.sql === 'string' || typeof input.statement === 'string');
}

export function getToolView(toolName: string | undefined, input: any): ToolView | null {
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    return {
      icon: <PencilSimple size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />,
      label: (t) => t.toolTitle ?? t.toolName ?? 'Edit',
      expanded: (t) => <DiffView tool={t} />,
    };
  }
  if (toolName === 'TodoWrite') {
    return {
      icon: <ListChecks size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />,
      label: () => 'Updated plan',
      expanded: (t) => <TodoView tool={t} />,
    };
  }
  // WebSearch input also carries a `query` field, so it MUST be matched before hasQuery.
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return {
      icon: <Globe size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />,
      label: (t) => t.toolTitle ?? t.toolName ?? 'Web',
      expanded: (t, r) => <WebView tool={t} result={r} />,
    };
  }
  if (hasQuery(input)) {
    return {
      icon: <Database size={13} color="#5A8DD6" style={{ flexShrink: 0 }} />,
      label: (t) => t.toolTitle ?? t.toolName ?? 'Query',
      expanded: (t, r) => <QueryView tool={t} result={r} />,
    };
  }
  return null;
}
