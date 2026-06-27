import { useEffect, useState } from 'react';
import type { ConvItem } from '../../../api/types';
import { api } from '../../../api/client';
import { parseQuestions, buildAnswerInput, type AskQuestion } from './answerInput';
import { useQuestionAnswers } from '../../../stores/questionAnswers';

export function AskQuestionView({ tool, result, answerable, terminalId, onAnswerInTerminal }: {
  tool: ConvItem; result?: ConvItem; answerable: boolean; terminalId: string; onAnswerInTerminal: () => void;
}) {
  const questions = parseQuestions(tool.toolInput);
  const uuid = tool.uuid ?? '';
  const submitted = useQuestionAnswers((s) => (uuid ? s.byUuid[uuid] : undefined));
  const [sel, setSel] = useState<number[][]>(() => questions.map(() => []));
  const [showFallback, setShowFallback] = useState(false);

  const isSubmitted = !!submitted || !!result;
  const active = answerable && !isSubmitted;

  // 6s after a local submit with no result yet, surface the Terminal fallback.
  useEffect(() => {
    if (!submitted || result) { setShowFallback(false); return; }
    const t = setTimeout(() => setShowFallback(true), 6000);
    return () => clearTimeout(t);
  }, [submitted, result]);

  if (!questions.length) return null;

  function toggle(qi: number, oi: number, multi: boolean) {
    setSel((prev) => {
      const next = prev.map((a) => a.slice());
      if (multi) {
        const at = next[qi].indexOf(oi);
        if (at >= 0) next[qi].splice(at, 1); else next[qi].push(oi);
      } else {
        next[qi] = [oi];
      }
      return next;
    });
  }

  function submit(selections: number[][]) {
    if (!active || !uuid) return;
    useQuestionAnswers.getState().submit(uuid, selections);
    void api.sendInput(terminalId, buildAnswerInput(questions, selections)).catch(() => {});
  }

  // chosen indices for highlight: prefer the optimistic record, else best-effort from result text.
  const chosen = submitted ?? chosenFromResult(questions, result?.text);
  const allAnswered = sel.every((a) => a.length > 0);
  const singleQuick = questions.length === 1 && !questions[0].multiSelect;

  return (
    <div style={{ border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)', borderRadius: 10, background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)', overflow: 'hidden' }}>
      {questions.map((q, qi) => (
        <QuestionBlock
          key={qi} q={q}
          selected={chosen?.[qi] ?? sel[qi]}
          interactive={active}
          onToggle={(oi) => {
            if (!active) return;
            if (!q.multiSelect && questions.length === 1) { submit([[oi]]); return; }
            toggle(qi, oi, !!q.multiSelect);
          }}
        />
      ))}
      {active && !singleQuick && (
        <div style={{ padding: '0 13px 12px' }}>
          <button onClick={() => submit(sel)} disabled={!allAnswered}
            style={{ background: allAnswered ? 'var(--color-accent)' : 'var(--color-elevated)', color: allAnswered ? '#06140B' : 'var(--color-text-tertiary)', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: allAnswered ? 'pointer' : 'default' }}>
            Submit
          </button>
        </div>
      )}
      {isSubmitted && !result && (
        <div style={{ padding: '0 13px 12px', fontSize: 12, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>Submitted — waiting for the thread…</span>
          {showFallback && <button onClick={onAnswerInTerminal} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Answer in Terminal →</button>}
        </div>
      )}
    </div>
  );
}

function QuestionBlock({ q, selected, interactive, onToggle }: {
  q: AskQuestion; selected: number[]; interactive: boolean; onToggle: (oi: number) => void;
}) {
  return (
    <div style={{ padding: '11px 13px', borderTop: '1px solid var(--color-border)' }}>
      {q.header && <div style={{ display: 'inline-block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--color-accent)', border: '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)', borderRadius: 5, padding: '1px 6px', marginBottom: 6 }}>{q.header}</div>}
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8 }}>{q.question}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {q.options.map((o, oi) => {
          const on = selected.includes(oi);
          return (
            <button key={oi} onClick={() => onToggle(oi)} disabled={!interactive}
              style={{ textAlign: 'left', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 8, padding: '8px 10px', background: on ? 'color-mix(in srgb, var(--color-accent) 14%, transparent)' : 'var(--color-elevated)', cursor: interactive ? 'pointer' : 'default' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>{o.label}</div>
              {o.description && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{o.description}</div>}
              {o.preview && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4, font: '400 11px var(--font-mono)', whiteSpace: 'pre-wrap' }}>{o.preview}</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function chosenFromResult(questions: AskQuestion[], text?: string): number[][] | null {
  if (!text) return null;
  let any = false;
  const out = questions.map((q) => {
    const idxs: number[] = [];
    q.options.forEach((o, i) => { if (o.label && text.includes(o.label)) { idxs.push(i); any = true; } });
    return idxs;
  });
  return any ? out : null;
}
