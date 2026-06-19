import type { Session, Terminal, Provider, FileEntry, AuthRequest, SessionStats, InboxUpload, AgentSchedule, AgentRun, CreateScheduleInput } from './types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body,
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const body = (data: unknown) => JSON.stringify(data);

export const api = {
  listSessions: () => req<Session[]>('/api/sessions'),
  getSession: (id: string) => req<Session>(`/api/sessions/${id}`),
  createSession: (input: { provider: string; name?: string; workingDir: string; prompt?: string; skipPermissions?: boolean }) =>
    req<Session>('/api/sessions', { method: 'POST', body: body(input) }),
  updateSession: (id: string, fields: { name?: string; notes?: string }) =>
    req<Session>(`/api/sessions/${id}`, { method: 'PATCH', body: body(fields) }),
  archiveSession: (id: string) => req<void>(`/api/sessions/${id}`, { method: 'DELETE' }),
  reorderSessions: (order: string[]) => req<void>('/api/sessions/reorder', { method: 'POST', body: body({ order }) }),

  listTerminals: (sessionId: string) => req<Terminal[]>(`/api/sessions/${sessionId}/terminals`),
  listArchivedTerminals: (sessionId: string) => req<Terminal[]>(`/api/sessions/${sessionId}/terminals/archived`),
  createTerminal: (sessionId: string, input: { type: string; label?: string; workingDir?: string; externalId?: string; config?: Record<string, unknown> }) =>
    req<Terminal>(`/api/sessions/${sessionId}/terminals`, { method: 'POST', body: body(input) }),
  getTerminal: (id: string) => req<Terminal>(`/api/terminals/${id}`),
  updateTerminal: (id: string, fields: { label?: string; config?: Record<string, unknown> }) =>
    req<Terminal>(`/api/terminals/${id}`, { method: 'PATCH', body: body(fields) }),
  relaunchTerminal: (id: string) => req<Terminal>(`/api/terminals/${id}/relaunch`, { method: 'POST' }),
  restoreTerminal: (id: string) => req<Terminal>(`/api/terminals/${id}/restore`, { method: 'POST' }),
  stopTerminal: (id: string) => req<void>(`/api/terminals/${id}/stop`, { method: 'POST' }),
  archiveTerminal: (id: string) => req<void>(`/api/terminals/${id}`, { method: 'DELETE' }),
  reorderTerminals: (sessionId: string, order: string[]) =>
    req<void>(`/api/sessions/${sessionId}/terminals/reorder`, { method: 'POST', body: body({ order }) }),
  moveTerminal: (id: string, sessionId: string) =>
    req<Terminal>(`/api/terminals/${id}/move`, { method: 'POST', body: body({ sessionId }) }),

  listProviders: () => req<Provider[]>('/api/providers'),
  getGitInfo: (sessionId: string) => req<{ branch: string | null }>(`/api/sessions/${sessionId}/git`),
  getLastDirectory: () => req<{ directory: string | null }>('/api/state/last-directory'),
  browse: (path: string) => req<FileEntry[]>(`/api/state/browse?path=${encodeURIComponent(path)}`),
  stateMkdir: (path: string) => req<{ ok: true; path: string }>(`/api/state/mkdir?path=${encodeURIComponent(path)}`, { method: 'POST' }),
  getSessionStats: (sessionId: string) => req<SessionStats>(`/api/state/session-stats/${sessionId}`),

  // Files (sandboxed to the session working dir)
  listFiles: (sessionId: string, p = '.') => req<FileEntry[]>(`/api/sessions/${sessionId}/files?path=${encodeURIComponent(p)}`),
  readFile: (sessionId: string, p: string) => req<{ content: string; path: string }>(`/api/sessions/${sessionId}/files/read?path=${encodeURIComponent(p)}`),
  writeFile: (sessionId: string, p: string, content: string) =>
    req<{ ok: true; path: string }>(`/api/sessions/${sessionId}/files/write?path=${encodeURIComponent(p)}`, { method: 'PUT', body: body({ content }) }),
  makeDirectory: (sessionId: string, p: string) =>
    req<{ ok: true; path: string }>(`/api/sessions/${sessionId}/files/mkdir?path=${encodeURIComponent(p)}`, { method: 'POST' }),
  renameFile: (sessionId: string, from: string, to: string) =>
    req<{ ok: true; path: string }>(`/api/sessions/${sessionId}/files/rename`, { method: 'POST', body: body({ from, to }) }),
  deleteFile: (sessionId: string, p: string) =>
    req<{ ok: true }>(`/api/sessions/${sessionId}/files?path=${encodeURIComponent(p)}`, { method: 'DELETE' }),
  uploadInbox: async (sessionId: string, file: File): Promise<InboxUpload> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/sessions/${sessionId}/files/inbox`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return (await res.json()) as InboxUpload;
  },
  sendFileReference: (terminalId: string, p: string, mode: 'agent-context' | 'shell-path' = 'agent-context') =>
    req<{ ok: true; sentText: string }>(`/api/terminals/${terminalId}/send-file-reference`, { method: 'POST', body: body({ path: p, mode }) }),

  // Agents (schedules + runs)
  listSchedules: (projectId?: string) => req<AgentSchedule[]>(`/api/agents/schedules${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  getSchedule: (id: string) => req<AgentSchedule>(`/api/agents/schedules/${id}`),
  createSchedule: (input: CreateScheduleInput) => req<AgentSchedule>('/api/agents/schedules', { method: 'POST', body: body(input) }),
  updateSchedule: (id: string, fields: Partial<CreateScheduleInput>) => req<AgentSchedule>(`/api/agents/schedules/${id}`, { method: 'PATCH', body: body(fields) }),
  deleteSchedule: (id: string) => req<void>(`/api/agents/schedules/${id}`, { method: 'DELETE' }),
  runScheduleNow: (id: string) => req<AgentRun>(`/api/agents/schedules/${id}/run-now`, { method: 'POST' }),
  listRuns: (q: { scheduleId?: string; projectId?: string } = {}) => {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    const qs = params.toString();
    return req<AgentRun[]>(`/api/agents/runs${qs ? `?${qs}` : ''}`);
  },
  cancelRun: (id: string) => req<AgentRun>(`/api/agents/runs/${id}/cancel`, { method: 'POST' }),
  markRunOpened: (id: string) => req<AgentRun>(`/api/agents/runs/${id}/opened`, { method: 'POST' }),

  // Browser auth relay
  listAuthRequests: () => req<AuthRequest[]>('/api/auth-requests'),
  markAuthOpened: (id: string) => req<AuthRequest>(`/api/auth-requests/${id}/opened`, { method: 'POST' }),
  completeAuth: (id: string) => req<AuthRequest>(`/api/auth-requests/${id}/complete`, { method: 'POST' }),
  forwardAuthCallback: (id: string, url: string) =>
    req<AuthRequest>(`/api/auth-requests/${id}/callback`, { method: 'POST', body: body({ url }) }),
};
