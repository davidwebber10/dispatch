import { useState } from 'react';
import { Modal } from '../common/Modal';
import { api } from '../../api/client';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import type { AgentSchedule, CreateScheduleInput } from '../../api/types';

type Mode = 'manual' | 'interval' | 'daily' | 'weekly' | 'cron';
const MODES: Mode[] = ['manual', 'interval', 'daily', 'weekly', 'cron'];
const WEEKDAYS: { l: string; d: number }[] = [
  { l: 'M', d: 1 }, { l: 'T', d: 2 }, { l: 'W', d: 3 }, { l: 'T', d: 4 }, { l: 'F', d: 5 }, { l: 'S', d: 6 }, { l: 'S', d: 0 },
];

interface SchedState { mode: Mode; intervalN: number; intervalUnit: 'minutes' | 'hours'; time: string; days: number[]; cron: string; }

function ruleFor(s: SchedState): { scheduleKind: 'one-shot' | 'recurring'; recurrenceRule: string | null } {
  switch (s.mode) {
    case 'manual': return { scheduleKind: 'one-shot', recurrenceRule: null };
    case 'interval': {
      const everyMinutes = s.intervalUnit === 'hours' ? s.intervalN * 60 : s.intervalN;
      return { scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'interval', everyMinutes }) };
    }
    case 'daily': return { scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'daily', time: s.time }) };
    case 'weekly': return { scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'weekly', days: [...s.days].sort(), time: s.time }) };
    case 'cron': return { scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'cron', expr: s.cron.trim() }) };
  }
}

// A human-readable cron preview derived from the picker state (display only).
function cronPreview(s: SchedState): string {
  if (s.mode === 'manual') return 'No schedule — run manually';
  if (s.mode === 'cron') return s.cron.trim() || '— enter a cron expression —';
  const [h, m] = s.time.split(':').map(Number);
  if (s.mode === 'daily') return `${m} ${h} * * *`;
  if (s.mode === 'weekly') return `${m} ${h} * * ${s.days.length ? [...s.days].sort().join(',') : '*'}`;
  // interval
  if (s.intervalUnit === 'minutes' && 60 % s.intervalN === 0 && s.intervalN < 60) return `*/${s.intervalN} * * * *`;
  if (s.intervalUnit === 'hours' && 24 % s.intervalN === 0) return `0 */${s.intervalN} * * *`;
  return `every ${s.intervalN} ${s.intervalUnit}`;
}

function initSched(existing: AgentSchedule | null): SchedState {
  const base: SchedState = { mode: 'daily', intervalN: 6, intervalUnit: 'hours', time: '09:00', days: [1, 2, 3, 4, 5], cron: '0 9 * * 1-5' };
  if (!existing) return base;
  if (existing.scheduleKind === 'one-shot') return { ...base, mode: 'manual' };
  try {
    const r = existing.recurrenceRule ? JSON.parse(existing.recurrenceRule) : null;
    if (r?.type === 'manual') return { ...base, mode: 'manual' };
    if (r?.type === 'interval' || r?.type === 'interval-minutes') return { ...base, mode: 'interval', intervalN: r.everyMinutes >= 60 && r.everyMinutes % 60 === 0 ? r.everyMinutes / 60 : r.everyMinutes, intervalUnit: r.everyMinutes >= 60 && r.everyMinutes % 60 === 0 ? 'hours' : 'minutes' };
    if (r?.type === 'interval-hours') return { ...base, mode: 'interval', intervalN: r.hours, intervalUnit: 'hours' };
    if (r?.type === 'daily') return { ...base, mode: 'daily', time: r.time ?? '09:00' };
    if (r?.type === 'weekly') return { ...base, mode: 'weekly', time: r.time ?? '09:00', days: Array.isArray(r.days) ? r.days : [1, 2, 3, 4, 5] };
    if (r?.type === 'cron') return { ...base, mode: 'cron', cron: r.expr ?? '' };
  } catch { /* fall through */ }
  return base;
}

const input: React.CSSProperties = { height: 34, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13 };
const seg = (active: boolean): React.CSSProperties => ({ padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12.5, textTransform: 'capitalize', background: active ? 'var(--color-accent)' : 'transparent', color: active ? '#08240F' : 'var(--color-text-secondary)', fontWeight: active ? 600 : 400 });

export function EditAgentModal({ scheduleId, onClose }: { scheduleId: string | null; onClose: () => void }) {
  const existing = useAgents((s) => s.schedules.find((x) => x.id === scheduleId)) ?? null;
  const sessions = useProjects((s) => s.sessions);

  const [projectId, setProjectId] = useState(existing?.projectId ?? sessions[0]?.id ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [provider, setProvider] = useState<AgentSchedule['provider']>(existing?.provider ?? 'claude-code');
  const [prompt, setPrompt] = useState(existing?.prompt ?? '');
  const [sched, setSched] = useState<SchedState>(() => initSched(existing));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SchedState>) => setSched((s) => ({ ...s, ...patch }));

  async function save() {
    const project = sessions.find((s) => s.id === projectId);
    if (!project || !name.trim()) return;
    setBusy(true);
    try {
      const { scheduleKind, recurrenceRule } = ruleFor(sched);
      const payload: CreateScheduleInput = {
        projectId, name: name.trim(), provider, workingDir: project.workingDir, prompt,
        scheduleKind, runAt: null, recurrenceRule,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        enabled: true, nextRunAt: null, defaultTerminalLabel: null,
      };
      if (existing) await api.updateSchedule(existing.id, payload);
      else await api.createSchedule(payload);
      await useAgents.getState().loadSchedules();
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={existing ? 'Edit Agent' : 'New Agent'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={input}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input style={input} placeholder="Agent name" value={name} onChange={(e) => setName(e.target.value)} />
        <div style={{ display: 'inline-flex', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: 3, width: 'fit-content' }}>
          {(['claude-code', 'codex'] as const).map((p) => (
            <button key={p} onClick={() => setProvider(p)} style={seg(provider === p)}>{p === 'claude-code' ? 'Claude Code' : 'Codex'}</button>
          ))}
        </div>
        <textarea placeholder="Instructions / trigger prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ ...input, height: 94, padding: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }} />

        {/* Schedule */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <span style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' }}>SCHEDULE</span>
          <div style={{ display: 'inline-flex', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 9, padding: 3, gap: 2, width: 'fit-content' }}>
            {MODES.map((m) => <button key={m} onClick={() => set({ mode: m })} style={seg(sched.mode === m)}>{m}</button>)}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minHeight: 34 }}>
            {sched.mode === 'interval' && (<>
              <input type="number" min={1} value={sched.intervalN} onChange={(e) => set({ intervalN: Math.max(1, Number(e.target.value)) })} style={{ ...input, width: 80 }} />
              <div style={{ display: 'inline-flex', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: 3 }}>
                {(['minutes', 'hours'] as const).map((u) => <button key={u} onClick={() => set({ intervalUnit: u })} style={seg(sched.intervalUnit === u)}>{u}</button>)}
              </div>
            </>)}
            {sched.mode === 'daily' && <input type="time" value={sched.time} onChange={(e) => set({ time: e.target.value })} style={{ ...input, width: 120 }} />}
            {sched.mode === 'weekly' && (<>
              <input type="time" value={sched.time} onChange={(e) => set({ time: e.target.value })} style={{ ...input, width: 120 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                {WEEKDAYS.map((w, i) => {
                  const on = sched.days.includes(w.d);
                  return (
                    <button key={i} onClick={() => set({ days: on ? sched.days.filter((x) => x !== w.d) : [...sched.days, w.d] })}
                      style={{ width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', font: '600 11px var(--font-mono)', background: on ? 'var(--color-accent)' : 'var(--color-elevated)', color: on ? '#08240F' : 'var(--color-text-tertiary)', border: on ? 'none' : '1px solid #2C2C32' }}>{w.l}</button>
                  );
                })}
              </div>
            </>)}
            {sched.mode === 'cron' && <input value={sched.cron} onChange={(e) => set({ cron: e.target.value })} placeholder="0 9 * * 1-5" style={{ ...input, width: 200, fontFamily: 'var(--font-mono)' }} />}
          </div>

          <div style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
            {sched.mode === 'manual' ? 'No schedule — run manually with “Run now”.' : <>cron <span style={{ color: 'var(--color-text-secondary)' }}>{cronPreview(sched)}</span> · {Intl.DateTimeFormat().resolvedOptions().timeZone}</>}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', cursor: 'pointer' }}>Cancel</button>
        <button disabled={busy} onClick={() => void save()} style={{ height: 32, padding: '0 18px', background: 'var(--color-accent)', border: 'none', borderRadius: 8, color: '#08240F', fontWeight: 600, cursor: 'pointer' }}>Save Agent</button>
      </div>
    </Modal>
  );
}
