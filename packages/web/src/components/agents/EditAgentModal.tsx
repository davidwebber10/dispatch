import { useState } from 'react';
import { Modal } from '../common/Modal';
import { api } from '../../api/client';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import type { AgentSchedule, CreateScheduleInput } from '../../api/types';

type Recur = 'manual' | 'daily' | 'interval';

function ruleFor(recur: Recur, time: string, hours: number): { scheduleKind: 'one-shot' | 'recurring'; recurrenceRule: string | null } {
  if (recur === 'daily') return { scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'daily', time }) };
  if (recur === 'interval') return { scheduleKind: 'recurring', recurrenceRule: JSON.stringify({ type: 'interval-hours', hours }) };
  return { scheduleKind: 'one-shot', recurrenceRule: null };
}

const input: React.CSSProperties = { height: 34, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13 };

export function EditAgentModal({ scheduleId, onClose }: { scheduleId: string | null; onClose: () => void }) {
  const existing = useAgents((s) => s.schedules.find((x) => x.id === scheduleId)) ?? null;
  const sessions = useProjects((s) => s.sessions);

  const [projectId, setProjectId] = useState(existing?.projectId ?? sessions[0]?.id ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [provider, setProvider] = useState<AgentSchedule['provider']>(existing?.provider ?? 'claude-code');
  const [prompt, setPrompt] = useState(existing?.prompt ?? '');
  const initialRule = (() => {
    if (existing?.scheduleKind === 'one-shot') return 'manual' as Recur;
    try { const r = existing?.recurrenceRule ? JSON.parse(existing.recurrenceRule) : null; if (r?.type === 'interval-hours') return 'interval' as Recur; } catch { /* */ }
    return 'daily' as Recur;
  })();
  const [recur, setRecur] = useState<Recur>(initialRule);
  const [time, setTime] = useState('09:00');
  const [hours, setHours] = useState(6);
  const [busy, setBusy] = useState(false);

  async function save() {
    const project = sessions.find((s) => s.id === projectId);
    if (!project || !name.trim()) return;
    setBusy(true);
    try {
      const { scheduleKind, recurrenceRule } = ruleFor(recur, time, hours);
      const payload: CreateScheduleInput = {
        projectId,
        name: name.trim(),
        provider,
        workingDir: project.workingDir,
        prompt,
        scheduleKind,
        runAt: null,
        recurrenceRule,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        enabled: true,
        nextRunAt: null,
        defaultTerminalLabel: null,
      };
      if (existing) await api.updateSchedule(existing.id, payload);
      else await api.createSchedule(payload);
      await useAgents.getState().loadSchedules();
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={existing ? 'Edit Agent' : 'New Agent'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={input}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input style={input} placeholder="Agent name" value={name} onChange={(e) => setName(e.target.value)} />
        <div style={{ display: 'inline-flex', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: 3, width: 'fit-content' }}>
          {(['claude-code', 'codex'] as const).map((p) => (
            <button key={p} onClick={() => setProvider(p)} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12.5, background: provider === p ? 'var(--color-accent)' : 'transparent', color: provider === p ? '#08240F' : 'var(--color-text-secondary)', fontWeight: provider === p ? 600 : 400 }}>{p === 'claude-code' ? 'Claude Code' : 'Codex'}</button>
          ))}
        </div>
        <textarea placeholder="Instructions / trigger prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ ...input, height: 94, padding: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {(['manual', 'daily', 'interval'] as const).map((r) => (
            <button key={r} onClick={() => setRecur(r)} style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #2C2C32', cursor: 'pointer', fontSize: 12.5, background: recur === r ? 'var(--color-accent)' : 'var(--color-elevated)', color: recur === r ? '#08240F' : 'var(--color-text-secondary)', textTransform: 'capitalize' }}>{r}</button>
          ))}
          {recur === 'daily' && <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ ...input, width: 110 }} />}
          {recur === 'interval' && <input type="number" min={1} value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ ...input, width: 80 }} />}
          {recur === 'interval' && <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>hours</span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Weekly &amp; cron schedules need the server recurrence extension (gap B) — tracked for follow-up.</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)' }}>Cancel</button>
        <button disabled={busy} onClick={() => void save()} style={{ height: 32, padding: '0 18px', background: 'var(--color-accent)', border: 'none', borderRadius: 8, color: '#08240F', fontWeight: 600 }}>Save Agent</button>
      </div>
    </Modal>
  );
}
