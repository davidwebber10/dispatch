import type { EndlessMessage } from '../../api/types';

export const SPAWN_TOOL = /^mcp__memory__spawn_agent\s/;

export type Spawn =
  | { kind: 'starting'; name: string; projectName: string | null; task: string }
  | { kind: 'started'; agentId: string; label: string; projectName: string | null; projectId: string | null; task: string }
  | { kind: 'failed'; name: string; error: string; task: string };

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';
export function parseSpawn(tool: EndlessMessage, echo?: EndlessMessage): Spawn {
  let input: { name?: unknown; project?: unknown; task?: unknown; agentType?: unknown } = {};
  try { input = JSON.parse(tool.text.replace(SPAWN_TOOL, '')); } catch { /* keep {} */ }
  const name = (typeof input.name === 'string' && input.name.trim()) || `${typeof input.agentType === 'string' ? input.agentType : 'thread'} agent`;
  const projectName = typeof input.project === 'string' ? input.project : null;
  const task = typeof input.task === 'string' ? input.task : '';
  if (!echo) return { kind: 'starting', name, projectName, task };
  try {
    const r = JSON.parse(echo.text) as { agentId?: unknown; label?: unknown; project?: unknown; projectId?: unknown };
    if (typeof r.agentId === 'string' && r.agentId) {
      return { kind: 'started', agentId: r.agentId, label: typeof r.label === 'string' ? r.label : name, projectName: typeof r.project === 'string' ? r.project : projectName, projectId: typeof r.projectId === 'string' ? r.projectId : null, task };
    }
  } catch { /* not JSON: the spawn failed */ }
  return { kind: 'failed', name, error: firstLine(echo.text), task };
}
