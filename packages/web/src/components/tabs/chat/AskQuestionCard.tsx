import { useState } from 'react';
import { CaretRight, CheckCircle, Question } from '@phosphor-icons/react';
import type { PermissionQuestion } from '../../../api/types';

/** An option is either a bare label string or an object carrying label/name + description. */
function optionLabel(o: string | { label?: string; name?: string; description?: string }): string {
  return typeof o === 'string' ? o : (o.label ?? o.name ?? '');
}
function optionDesc(o: string | { label?: string; name?: string; description?: string }): string | undefined {
  return typeof o === 'string' ? undefined : o.description;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/**
 * Interactive AskUserQuestion card for a structured Claude thread. Renders each
 * question's options as tappable controls and, on submit, hands `onAnswer` a map
 * keyed by question TEXT → the chosen option label(s) (multi-select joined with
 * ", "). That exact wire shape is what real `claude --permission-prompt-tool stdio`
 * expects to unblock the tool — see useStructuredChat.answer / the /permission route.
 *
 * A single single-select question submits immediately on tap (the fast mobile path);
 * anything else (multi-select or several questions) accumulates selections behind a
 * Submit button that's disabled until every question has an answer.
 */
export function AskQuestionCard({ questions, onAnswer }: { questions: PermissionQuestion[]; onAnswer: (answers: Record<string, string>) => void }) {
  // question index → chosen labels (single-select holds 0..1; multi-select holds 0..n).
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [submitted, setSubmitted] = useState(false);

  const autoSubmit = questions.length === 1 && !questions[0]?.multiSelect;

  const submit = (answers: Record<string, string>) => {
    if (submitted) return;
    setSubmitted(true);
    onAnswer(answers);
  };

  const buildAndSubmit = (next: Record<number, string[]>) => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => { answers[q.question] = (next[i] ?? []).join(', '); });
    submit(answers);
  };

  const pick = (qi: number, label: string, multi: boolean) => {
    if (submitted) return;
    if (autoSubmit) { submit({ [questions[qi].question]: label }); return; }
    setSel((prev) => {
      const cur = prev[qi] ?? [];
      const nextLabels = multi
        ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])
        : [label];
      return { ...prev, [qi]: nextLabels };
    });
  };

  const allAnswered = questions.every((_, i) => (sel[i]?.length ?? 0) > 0);

  return (
    <div style={{ border: '1px solid var(--color-accent)', borderRadius: 12, background: 'color-mix(in srgb, var(--color-accent) 7%, var(--color-elevated))', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {questions.map((q, qi) => {
        const multi = q.multiSelect === true;
        const chosen = sel[qi] ?? [];
        return (
          <div key={qi} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Question size={15} weight="fill" color="var(--color-accent)" />
              {q.header && (
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)', padding: '1px 7px', borderRadius: 6 }}>{q.header}</span>
              )}
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.45 }}>{q.question}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(q.options ?? []).map((o, oi) => {
                const label = optionLabel(o);
                const desc = optionDesc(o);
                const isSel = chosen.includes(label);
                return (
                  <button
                    key={oi}
                    onClick={() => pick(qi, label, multi)}
                    disabled={submitted}
                    style={{
                      textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2,
                      border: isSel ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
                      background: isSel ? 'color-mix(in srgb, var(--color-accent) 16%, var(--color-elevated))' : 'var(--color-elevated)',
                      color: 'var(--color-text-primary)', borderRadius: 9, padding: '9px 12px',
                      cursor: submitted ? 'default' : 'pointer', font: '400 14px var(--font-sans)', opacity: submitted && !isSel ? 0.5 : 1, transition: 'background .12s, border-color .12s',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flexShrink: 0, width: 15, height: 15, borderRadius: multi ? 4 : '50%', border: isSel ? '4px solid var(--color-accent)' : '1.5px solid var(--color-text-tertiary)', boxSizing: 'border-box' }} />
                      <span style={{ fontWeight: 500 }}>{label}</span>
                    </span>
                    {desc && <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', paddingLeft: 23, lineHeight: 1.4 }}>{desc}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {!autoSubmit && (
        <button
          onClick={() => buildAndSubmit(sel)}
          disabled={submitted || !allAnswered}
          style={{
            alignSelf: 'flex-end', border: 'none', borderRadius: 9, padding: '8px 18px', fontWeight: 600, fontSize: 13.5,
            background: allAnswered && !submitted ? 'var(--color-accent)' : 'var(--color-hover)',
            color: allAnswered && !submitted ? '#06140B' : 'var(--color-text-tertiary)',
            cursor: allAnswered && !submitted ? 'pointer' : 'default', transition: 'background .15s',
          }}
        >
          {submitted ? 'Sent' : 'Submit'}
        </button>
      )}
    </div>
  );
}

/**
 * The real Claude Code CLI's own AskUserQuestion tool_result is a fixed-template sentence —
 * `Your questions have been answered: "Q1"="A1", "Q2"="A2". You can now continue with these
 * answers in mind.` (verified against real captured transcripts; Dispatch doesn't generate
 * this text, the CLI's built-in tool implementation does) — not JSON, so it can't be
 * JSON.parse'd. Bound each answer by searching for the NEXT question's own exact marker
 * (rather than a generic quote/comma regex) so a question's wording that itself contains a
 * quote or comma can't misplace the boundary. Returns null if the template doesn't match
 * (e.g. a future CLI version) — callers fall back to showing `resultText` verbatim.
 */
function parseAnsweredResult(resultText: string, questions: PermissionQuestion[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i].question;
    const marker = `"${q}"="`;
    const start = resultText.indexOf(marker);
    if (start === -1) return null;
    const answerStart = start + marker.length;
    let end: number;
    if (i + 1 < questions.length) {
      const nextMarker = `", "${questions[i + 1].question}"="`;
      const nextIdx = resultText.indexOf(nextMarker, answerStart);
      end = nextIdx !== -1 ? nextIdx : resultText.length;
    } else {
      const tailIdx = resultText.indexOf('". You can now continue', answerStart);
      end = tailIdx !== -1 ? tailIdx : resultText.length;
    }
    if (end < answerStart) return null;
    out[q] = resultText.slice(answerStart, end);
  }
  return out;
}

/**
 * A collapsed, expandable record of an AskUserQuestion that has already been answered —
 * rendered in the permanent timeline once the interactive <AskQuestionCard> above resolves
 * (its paired tool_result has landed), so an answered question stays in the conversation
 * instead of vanishing the instant it's answered. See ChatView's renderTimeline and
 * live.convItemsToStream for where this replaces the old "just drop it" behavior.
 */
export function AnsweredQuestionCard({ questions, resultText }: { questions: PermissionQuestion[]; resultText: string }) {
  const [open, setOpen] = useState(false);
  const parsed = parseAnsweredResult(resultText, questions);
  const first = questions[0];
  const firstAnswer = (first && parsed?.[first.question]) || resultText;

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 12, background: 'var(--color-elevated)', overflow: 'hidden' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: '10px 14px', textAlign: 'left', font: '400 13px var(--font-sans)' }}
      >
        <CaretRight size={11} weight="bold" color="var(--color-text-tertiary)" style={{ flexShrink: 0, transition: 'transform .12s', transform: open ? 'rotate(90deg)' : 'none' }} />
        <Question size={14} weight="fill" color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>
          <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{truncate(first?.question ?? 'Question', 60)}</span>
          {'  →  '}
          {truncate(firstAnswer, 60)}
          {questions.length > 1 && <span style={{ color: 'var(--color-text-tertiary)' }}> (+{questions.length - 1} more)</span>}
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {questions.map((q, qi) => {
            const answer = q.question ? parsed?.[q.question] : undefined;
            const chosen = (answer ?? '').split(', ').map((s) => s.trim()).filter(Boolean);
            return (
              <div key={qi} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {q.header && (
                  <span style={{ alignSelf: 'flex-start', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-tertiary)', background: 'var(--color-hover)', padding: '1px 7px', borderRadius: 6 }}>{q.header}</span>
                )}
                <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.4 }}>{q.question}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {(q.options ?? []).map((o, oi) => {
                    const label = optionLabel(o);
                    const desc = optionDesc(o);
                    const isSel = chosen.includes(label);
                    return (
                      <div
                        key={oi}
                        style={{
                          display: 'flex', flexDirection: 'column', gap: 2, borderRadius: 9, padding: '7px 11px',
                          border: isSel ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
                          background: isSel ? 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))' : 'transparent',
                          opacity: isSel ? 1 : 0.55,
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: 'var(--color-text-primary)' }}>
                          {isSel && <CheckCircle size={14} weight="fill" color="var(--color-accent)" />}
                          {label}
                        </span>
                        {desc && isSel && <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', paddingLeft: 22 }}>{desc}</span>}
                      </div>
                    );
                  })}
                </div>
                {answer == null && (
                  <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>{resultText}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
