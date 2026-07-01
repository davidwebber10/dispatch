import { useState } from 'react';
import { Question } from '@phosphor-icons/react';
import type { PermissionQuestion } from '../../../api/types';

/** An option is either a bare label string or an object carrying label/name + description. */
function optionLabel(o: string | { label?: string; name?: string; description?: string }): string {
  return typeof o === 'string' ? o : (o.label ?? o.name ?? '');
}
function optionDesc(o: string | { label?: string; name?: string; description?: string }): string | undefined {
  return typeof o === 'string' ? undefined : o.description;
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
