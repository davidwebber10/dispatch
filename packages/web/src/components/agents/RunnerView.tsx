import { useEffect, useState } from 'react';
import {
  CaretLeft, Sparkle, ChatText, Wrench, ListChecks, CheckCircle, XCircle,
  Brain, Coins, ArrowElbowDownRight, Terminal as TerminalIcon,
} from '@phosphor-icons/react';
import { TerminalTab } from '../tabs/TerminalTab';
import { useAgents } from '../../stores/agents';
import { useIsMobile } from '../../hooks/useIsMobile';
import { api } from '../../api/client';
import { statusColor, formatDuration, formatCost, formatTokens, runDurationMs } from '../../lib/agentStats';
import type { RunStep, AgentRun } from '../../api/types';

const ACTIVE = ['queued', 'starting', 'working', 'needs_input'];

/** Live-ticking elapsed time for an in-progress run; final duration otherwise. */
function useElapsed(run: AgentRun | null, active: boolean): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!run?.startedAt) return null;
  if (!active) return runDurationMs(run);
  return Date.now() - Date.parse(run.startedAt);
}

export function RunnerView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const run = useAgents((s) => s.runs.find((r) => r.id === runId)) ?? null;
  const schedule = useAgents((s) => s.schedules.find((x) => x.id === run?.scheduleId)) ?? null;
  const steps = useAgents((s) => s.runSteps[runId]) ?? [];
  const loadRunSteps = useAgents((s) => s.loadRunSteps);
  const isMobile = useIsMobile();
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    void loadRunSteps(runId);
    if (run?.unreadSince) void api.markRunOpened(runId);
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = run ? ACTIVE.includes(run.status) : false;
  const elapsed = useElapsed(run, active);

  if (!run) return <div style={{ flex: 1, padding: 24, color: 'var(--color-text-tertiary)' }}>Run not found.</div>;
  const color = statusColor(run.status);
  const timeline = steps.filter((s) => s.timeline);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 18px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <button onClick={onBack} title="Back" style={iconBtn}><CaretLeft size={16} weight="bold" /></button>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0, animation: active ? 'dispatchPulse 1.6s ease-in-out infinite' : undefined }} />
        <span style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{schedule?.name ?? 'Run'}</span>
        <span style={{ font: '500 11px var(--font-mono)', color, flexShrink: 0 }}>{run.status}{active ? ' · live' : ''}</span>
        <button onClick={() => setShowRaw((v) => !v)} title="Toggle raw output"
          style={{ ...ghostChip, marginLeft: 'auto', color: showRaw ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
          <TerminalIcon size={13} /> Raw
        </button>
        {active && (
          <button onClick={() => void api.cancelRun(run.id)}
            style={{ height: 28, padding: '0 12px', background: '#241313', border: '1px solid #4A1F22', borderRadius: 8, color: '#F0616D', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>Stop run</button>
        )}
      </div>

      {/* HUD strip */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, padding: '9px 18px', borderBottom: '1px solid var(--color-border)', flexShrink: 0, font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
        <Hud label="model" value={run.model ?? schedule?.provider ?? '—'} />
        <Hud label="tokens" value={formatTokens(run.totalTokens)} />
        <Hud label="cost" value={formatCost(run.costUsd)} />
        <Hud label="turns" value={run.numTurns != null ? String(run.numTurns) : '—'} />
        <Hud label="elapsed" value={formatDuration(elapsed)} />
      </div>

      {run.error && <div style={{ padding: '8px 18px', color: '#F0616D', fontSize: 12.5, fontFamily: 'var(--font-mono)', flexShrink: 0, whiteSpace: 'pre-wrap' }}>{run.error}</div>}

      {/* Body */}
      {showRaw ? (
        run.terminalId
          ? <TerminalTab key={run.terminalId} terminalId={run.terminalId} />
          : <Empty>No raw terminal for this run.</Empty>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: isMobile ? 'column' : 'row' }}>
          {/* Plan / steps */}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', padding: '14px 18px', borderRight: isMobile ? undefined : '1px solid var(--color-border)', borderBottom: isMobile ? '1px solid var(--color-border)' : undefined }}>
            <SectionLabel>PLAN · STEPS</SectionLabel>
            {timeline.length === 0 && <Empty>{active ? 'Waiting for the agent to start…' : 'No steps recorded.'}</Empty>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10 }}>
              {timeline.map((s, i) => <StepRow key={i} step={s} timeline />)}
              {active && <LiveCursor />}
            </div>
          </div>
          {/* Activity log */}
          <div style={{ flex: 1.25, minWidth: 0, minHeight: 0, overflow: 'auto', padding: '14px 18px' }}>
            <SectionLabel>ACTIVITY</SectionLabel>
            {steps.length === 0 && <Empty>{active ? 'Streaming…' : 'No activity recorded.'}</Empty>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10 }}>
              {steps.map((s, i) => <StepRow key={i} step={s} />)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepRow({ step, timeline }: { step: RunStep; timeline?: boolean }) {
  const { Icon, color } = stepVisual(step);
  if (step.kind === 'todos' && step.todos) {
    return (
      <div style={{ padding: '8px 10px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 8, margin: '4px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <ListChecks size={15} color="var(--color-accent)" weight="bold" />
          <span style={{ font: '500 10px var(--font-mono)', letterSpacing: '1px', color: 'var(--color-text-tertiary)' }}>PLAN</span>
        </div>
        {step.todos.map((t, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '2px 0', fontSize: 12.5 }}>
            <span style={{ flexShrink: 0, marginTop: 1, color: todoColor(t.status) }}>{todoGlyph(t.status)}</span>
            <span style={{ color: t.status === 'completed' ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)', textDecoration: t.status === 'completed' ? 'line-through' : undefined }}>{t.content}</span>
          </div>
        ))}
      </div>
    );
  }
  const isResult = step.kind === 'result';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 9, padding: isResult ? '8px 10px' : '5px 6px',
      borderRadius: 7, margin: isResult ? '6px 0 2px' : 0,
      background: isResult ? (step.status === 'error' ? 'rgba(240,97,109,.08)' : 'rgba(62,207,106,.08)') : undefined,
      border: isResult ? `1px solid ${step.status === 'error' ? 'rgba(240,97,109,.3)' : 'rgba(62,207,106,.3)'}` : undefined,
    }}>
      <Icon size={15} color={color} weight={isResult ? 'fill' : 'regular'} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: isResult ? 600 : 500, color: isResult ? color : 'var(--color-text-primary)' }}>{step.title}</div>
        {step.detail && (
          <div style={{
            font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)', marginTop: 2,
            whiteSpace: timeline ? 'nowrap' : 'pre-wrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.5,
          }}>{step.detail}</div>
        )}
      </div>
    </div>
  );
}

function stepVisual(step: RunStep): { Icon: typeof Wrench; color: string } {
  switch (step.kind) {
    case 'init': return { Icon: Sparkle, color: 'var(--color-accent)' };
    case 'assistant-text': return { Icon: ChatText, color: 'var(--color-text-secondary)' };
    case 'thinking': return { Icon: Brain, color: 'var(--color-text-tertiary)' };
    case 'tool-use': return { Icon: Wrench, color: '#5A8DD6' };
    case 'tool-result': return { Icon: ArrowElbowDownRight, color: step.status === 'error' ? 'var(--color-status-red)' : 'var(--color-text-tertiary)' };
    case 'todos': return { Icon: ListChecks, color: 'var(--color-accent)' };
    case 'usage': return { Icon: Coins, color: 'var(--color-text-tertiary)' };
    case 'result': return step.status === 'error' ? { Icon: XCircle, color: 'var(--color-status-red)' } : { Icon: CheckCircle, color: 'var(--color-accent)' };
  }
}

function todoGlyph(status: string): string {
  if (status === 'completed') return '☑';
  if (status === 'in_progress') return '▸';
  return '☐';
}
function todoColor(status: string): string {
  if (status === 'completed') return 'var(--color-accent)';
  if (status === 'in_progress') return 'var(--color-status-yellow)';
  return 'var(--color-text-tertiary)';
}

const Hud = ({ label, value }: { label: string; value: string }) => (
  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
    <span style={{ color: 'var(--color-text-tertiary)', letterSpacing: '.5px' }}>{label}</span>
    <span style={{ color: 'var(--color-text-primary)' }}>{value}</span>
  </span>
);
const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <div style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' }}>{children}</div>
);
const Empty = ({ children }: { children: React.ReactNode }) => (
  <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5, padding: '10px 0' }}>{children}</div>
);
const LiveCursor = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 6px' }}>
    <span style={{ width: 8, height: 14, background: 'var(--color-accent)', display: 'inline-block', animation: 'dispatchBlink 1.1s steps(1) infinite' }} />
  </div>
);

const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0, flexShrink: 0 };
const ghostChip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 9px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 6, fontSize: 11.5, cursor: 'pointer', flexShrink: 0 };
