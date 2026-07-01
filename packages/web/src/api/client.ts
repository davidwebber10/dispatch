import type { Session, Terminal, Provider, FileEntry, AuthRequest, SessionStats, InboxUpload, AgentSchedule, AgentRun, CreateScheduleInput, RunStep, AgentOverview, DopplerStatus, DopplerSecret, DopplerProject, DopplerConfig, Conversation, SearchMatch, SetupState, ProviderStatus, TailscaleStatus, CcRecentSession, CodexRecentSession, Integration, AddIntegrationInput, IntegrationsExport, ToolStatus, PendingPermission } from './types';

/**
 * A content block for a structured `user` turn (mirrors the daemon's wire shape). A
 * turn is still allowed to be a plain string everywhere; a block array additionally
 * lets it carry a REAL image (base64 inline, so the model SEES it) alongside text.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

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
  listServers: () => req<{ label: string; origin: string }[]>('/api/servers'),
  addServer: (label: string, origin: string) => req<{ label: string; origin: string }[]>('/api/servers', { method: 'POST', body: body({ label, origin }) }),
  removeServer: (origin: string) => req<{ label: string; origin: string }[]>(`/api/servers?origin=${encodeURIComponent(origin)}`, { method: 'DELETE' }),
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
  recentCcSessions: (sessionId: string) => req<CcRecentSession[]>(`/api/sessions/${sessionId}/cc-recent`),
  recentCodexSessions: (sessionId: string) => req<CodexRecentSession[]>(`/api/sessions/${sessionId}/codex-recent`),
  branchTerminal: (terminalId: string) => req<Terminal>(`/api/terminals/${terminalId}/branch`, { method: 'POST' }),
  getTerminal: (id: string) => req<Terminal>(`/api/terminals/${id}`),
  getConversation: (id: string, params: { since?: number; before?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.since != null) q.set('since', String(params.since));
    if (params.before != null) q.set('before', String(params.before));
    if (params.limit != null) q.set('limit', String(params.limit));
    const qs = q.toString();
    return req<Conversation>(`/api/terminals/${id}/conversation${qs ? `?${qs}` : ''}`);
  },
  searchConversation: (id: string, q: string) => req<{ matches: SearchMatch[] }>(`/api/terminals/${id}/conversation/search?q=${encodeURIComponent(q)}`),
  sendInput: (id: string, data: string) => req<void>(`/api/terminals/${id}/input`, { method: 'POST', body: body({ data }) }),
  // A plain string keeps the original `{ text }` wire (byte-identical); a block array
  // is sent as `{ content }` so an attached image travels as a real content block.
  // `source: 'user'` tags this as a direct human send (the single chokepoint every
  // composer funnels through), distinct from the coordinator's own agency-mcp sends.
  sendStructuredMessage: (id: string, content: string | ContentBlock[]) =>
    req<void>(`/api/terminals/${id}/message`, { method: 'POST', body: body({ ...(typeof content === 'string' ? { text: content } : { content }), source: 'user' }) }),
  // The membrane: the gated tool/question a structured AGENT thread is blocked on (or null).
  getPermission: (terminalId: string) => req<PendingPermission | null>(`/api/terminals/${terminalId}/permission`),
  // Resolve it: allow (optionally with an AskUserQuestion answers map) or deny (with a message).
  answerPermission: (terminalId: string, payload: { requestId?: string; decision: 'allow' | 'deny'; answers?: Record<string, string>; message?: string }) =>
    req<void>(`/api/terminals/${terminalId}/permission`, { method: 'POST', body: body(payload) }),
  // Autonomy dial: supervised (surface gated tools as Needs) ⇄ autonomous (auto-allow, run free).
  setAutonomy: (terminalId: string, mode: 'supervised' | 'autonomous') =>
    req<Terminal>(`/api/terminals/${terminalId}/autonomy`, { method: 'POST', body: body({ mode }) }),
  // Graceful interrupt: stop the current turn WITHOUT killing the thread.
  interrupt: (terminalId: string) => req<void>(`/api/terminals/${terminalId}/interrupt`, { method: 'POST' }),
  // Overseer: find-or-create this project's coordinator thread (idempotent) → { terminalId }.
  ensureOverseerCoordinator: (sessionId: string) =>
    req<{ terminalId: string }>(`/api/sessions/${sessionId}/overseer/coordinator`, { method: 'POST' }),

  getSetupState: () => req<SetupState>(`/api/setup/state`),
  recheckProviders: () => req<ProviderStatus[]>(`/api/setup/providers`),
  recheckTailscale: () => req<TailscaleStatus>(`/api/setup/tailscale`),
  completeSetup: () => req<{ ok: true }>(`/api/setup/complete`, { method: 'POST' }),
  updateTerminal: (id: string, fields: { label?: string; config?: Record<string, unknown> }) =>
    req<Terminal>(`/api/terminals/${id}`, { method: 'PATCH', body: body(fields) }),
  relaunchTerminal: (id: string) => req<Terminal>(`/api/terminals/${id}/relaunch`, { method: 'POST' }),
  restoreTerminal: (id: string) => req<Terminal>(`/api/terminals/${id}/restore`, { method: 'POST' }),
  // Launch a QUEUED worker (status='queued') now — moves it from the Queued bucket into live work.
  startTerminal: (id: string) => req<void>(`/api/terminals/${id}/start`, { method: 'POST' }),
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
  // Byte-route URL for an image file (sandboxed to the session working dir). Sync URL
  // builder (no fetch) so it can feed an <img src> directly; the route streams raw bytes.
  imageUrl: (sessionId: string, p: string) => `/api/sessions/${sessionId}/files/image?path=${encodeURIComponent(p)}`,
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

  // Voice dictation — upload recorded audio; the daemon resolves the key + calls the provider.
  transcribe: async (
    blob: Blob,
    opts: { provider: string; model: string; secretName: string; mimeType: string; language?: string },
  ): Promise<{ text: string; language?: string }> => {
    const fd = new FormData();
    fd.append('file', blob, 'audio');
    fd.append('provider', opts.provider);
    fd.append('model', opts.model);
    fd.append('secretName', opts.secretName);
    fd.append('mimeType', opts.mimeType);
    if (opts.language) fd.append('language', opts.language);
    const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(e.error || `transcribe failed: ${res.status}`);
    }
    return (await res.json()) as { text: string; language?: string };
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
  runEvents: (id: string) => req<{ steps: RunStep[] }>(`/api/agents/runs/${id}/events`),
  agentsOverview: () => req<AgentOverview>('/api/agents/overview'),

  // Secrets (Doppler)
  getSecretsStatus: () => req<DopplerStatus>('/api/secrets/status'),
  setDopplerConnection: (input: { token: string; project: string; config: string; enabled: boolean; readOnly: boolean }) =>
    req<DopplerStatus>('/api/secrets/connection', { method: 'PUT', body: body(input) }),
  disconnectDoppler: () => req<void>('/api/secrets/connection', { method: 'DELETE' }),
  listDopplerProjects: () => req<DopplerProject[]>('/api/secrets/projects'),
  listDopplerConfigs: (project: string) => req<DopplerConfig[]>(`/api/secrets/configs?project=${encodeURIComponent(project)}`),
  listSecrets: (q: { project?: string; config?: string } = {}) => {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    const qs = params.toString();
    return req<DopplerSecret[]>(`/api/secrets${qs ? `?${qs}` : ''}`);
  },
  setSecret: (input: { name: string; value: string }) => req<DopplerSecret>('/api/secrets', { method: 'POST', body: body(input) }),
  deleteSecret: (name: string) => req<void>(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Tools (bundled CLIs)
  getTools: () => req<{ tools: ToolStatus[] }>('/api/tools'),

  // Integrations (own MCP catalog)
  listIntegrations: () => req<{ integrations: Integration[] }>('/api/integrations'),
  addIntegration: (input: AddIntegrationInput) => req<Integration>('/api/integrations', { method: 'POST', body: body(input) }),
  setIntegrationEnabled: (id: string, enabled: boolean) => req<Integration>(`/api/integrations/${encodeURIComponent(id)}`, { method: 'PATCH', body: body({ enabled }) }),
  removeIntegration: (id: string) => req<{ removed: boolean }>(`/api/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  exportIntegrations: () => req<IntegrationsExport>('/api/integrations/export'),
  importIntegrations: (doc: IntegrationsExport) => req<{ added: string[]; skipped: string[] }>('/api/integrations/import', { method: 'POST', body: body(doc) }),

  // Push notifications
  getPushKey: () => req<{ publicKey: string }>('/api/push/key'),
  pushSubscribe: (deviceId: string, subscription: unknown) => req<{ ok: true }>('/api/push/subscribe', { method: 'POST', body: body({ deviceId, subscription }) }),
  pushUnsubscribe: (deviceId: string) => req<{ ok: true }>('/api/push/unsubscribe', { method: 'POST', body: body({ deviceId }) }),
  pushPresence: (deviceId: string, foreground: boolean) => req<{ ok: true }>('/api/push/presence', { method: 'POST', body: body({ deviceId, foreground }) }),

  // Browser auth relay
  listAuthRequests: () => req<AuthRequest[]>('/api/auth-requests'),
  markAuthOpened: (id: string) => req<AuthRequest>(`/api/auth-requests/${id}/opened`, { method: 'POST' }),
  completeAuth: (id: string) => req<AuthRequest>(`/api/auth-requests/${id}/complete`, { method: 'POST' }),
  forwardAuthCallback: (id: string, url: string) =>
    req<AuthRequest>(`/api/auth-requests/${id}/callback`, { method: 'POST', body: body({ url }) }),
};
