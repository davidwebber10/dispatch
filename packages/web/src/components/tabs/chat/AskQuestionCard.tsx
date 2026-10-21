import { useState } from 'react';
import { CaretRight, CheckCircle, Question } from '@phosphor-icons/react';
import type { PermissionQuestion } from '../../../api/types';
import { parseQuestionReply } from './questionReply';

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
 * Every card submits through the Submit button, which is disabled until every question has an
 * answer. Each question also takes an "Other" answer typed by the user, which goes through the
 * same allow path. Discuss sends text back without picking (onReply, the same path as a reply in
 * the composer), or with no text asks the model for more context (onDeny 'discuss'). Dismiss
 * closes the question unanswered (onDeny 'dismiss'). Both are hidden when their handler is absent.
 */
export function AskQuestionCard({ questions, onAnswer, onReply, onDeny }: {
  questions: PermissionQuestion[];
  /** Returning false means the host dropped the answer (another action is in flight), so the card unlocks. */
  onAnswer: (answers: Record<string, string>) => void | boolean;
  /** May return a promise: resolving false means the reply failed, and the card unlocks for another try. */
  onReply?: (text: string) => void | Promise<boolean>;
  onDeny?: (action: 'discuss' | 'dismiss') => void | Promise<boolean>;
}) {
  // question index → chosen labels (single-select holds 0..1; multi-select holds 0..n).
  const [sel, setSel] = useState<Record<number, string[]>>({});
  // question index → the typed "Other" answer; absent when Other is not chosen.
  const [other, setOther] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [discussOpen, setDiscussOpen] = useState(false);
  const [discussText, setDiscussText] = useState('');

  const answerFor = (i: number): string => {
    const picks = sel[i] ?? [];
    const typed = other[i]?.trim();
    return (typed ? [...picks, typed] : picks).join(', ');
  };

  const submit = () => {
    if (submitted) return;
    setSubmitted(true);
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => { answers[q.question] = answerFor(i); });
    if (onAnswer(answers) === false) setSubmitted(false);
  };

  const pick = (qi: number, label: string, multi: boolean) => {
    if (submitted) return;
    setSel((prev) => {
      const cur = prev[qi] ?? [];
      const nextLabels = multi
        ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])
        : [label];
      return { ...prev, [qi]: nextLabels };
    });
    // A single-select holds one answer: an option replaces a typed Other.
    if (!multi) setOther((prev) => { const next = { ...prev }; delete next[qi]; return next; });
  };

  const toggleOther = (qi: number, multi: boolean) => {
    if (submitted) return;
    const on = other[qi] !== undefined;
    setOther((prev) => {
      const next = { ...prev };
      if (on) delete next[qi]; else next[qi] = '';
      return next;
    });
    // A single-select holds one answer: choosing Other drops the picked option.
    if (!on && !multi) setSel((prev) => ({ ...prev, [qi]: [] }));
  };

  // Lock the whole card while a Dismiss, Discuss or typed reply is in flight, so Submit cannot race it.
  // A handler that settles false (or rejects) means nothing was sent, so the card unlocks to try again.
  const lockWhile = (result: void | Promise<boolean>) => {
    setSubmitted(true);
    if (result && typeof (result as Promise<boolean>).then === 'function') {
      (result as Promise<boolean>).then((ok) => { if (ok === false) setSubmitted(false); }, () => setSubmitted(false));
    }
  };

  const deny = (action: 'discuss' | 'dismiss') => {
    if (submitted) return;
    lockWhile(onDeny?.(action));
  };

  const sendDiscuss = () => {
    if (submitted) return;
    const text = discussText.trim();
    if (text) lockWhile(onReply?.(text)); else deny('discuss');
    setDiscussOpen(false);
    setDiscussText('');
  };

  const allAnswered = questions.every((_, i) => answerFor(i).length > 0);
  const actionStyle = {
    border: '1px solid var(--color-border)', borderRadius: 6, height: 30, padding: '0 12px', fontSize: 12.5,
    background: 'transparent', color: 'var(--color-text-secondary)', cursor: submitted ? 'default' : 'pointer',
  } as const;

  // NEEDS YOU card (2026-08-16 pretty-chat redesign): coral-tinted, dot + letterspaced mono
  // label + right meta — the same visual state as a needs_you StatusNotice, because to the
  // reader both mean exactly one thing: the thread is paused on them.
  return (
    <div style={{ border: '1px solid #7d4640', borderRadius: 6, background: 'rgba(243,113,101,.06)', padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: '#F37165', flexShrink: 0 }} />
        <span style={{ font: '500 9.5px var(--font-mono)', letterSpacing: '1.3px', color: '#f0a79f' }}>NEEDS YOU</span>
        <span style={{ flex: 1 }} />
        <span style={{ font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>paused · {questions.length} question{questions.length !== 1 ? 's' : ''}</span>
      </div>
      {questions.map((q, qi) => {
        const multi = q.multiSelect === true;
        const chosen = sel[qi] ?? [];
        const otherOn = other[qi] !== undefined;
        const optionStyle = (isSel: boolean) => ({
          textAlign: 'left' as const, display: 'flex', flexDirection: 'column' as const, gap: 2,
          border: isSel ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
          background: isSel ? 'color-mix(in srgb, var(--color-accent) 16%, var(--color-elevated))' : 'var(--color-elevated)',
          color: 'var(--color-text-primary)', borderRadius: 9, padding: '9px 12px',
          cursor: submitted ? 'default' : 'pointer', font: '400 14px var(--font-sans)', opacity: submitted && !isSel ? 0.5 : 1, transition: 'background .12s, border-color .12s',
        });
        const marker = (isSel: boolean) => (
          <span style={{ flexShrink: 0, width: 15, height: 15, borderRadius: multi ? 4 : '50%', border: isSel ? '4px solid var(--color-accent)' : '1.5px solid var(--color-text-tertiary)', boxSizing: 'border-box' }} />
        );
        return (
          <div key={qi} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {q.header && (
              <span style={{ alignSelf: 'flex-start', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-secondary)', background: 'var(--color-hover)', padding: '1px 7px', borderRadius: 6 }}>{q.header}</span>
            )}
            <div style={{ fontSize: 14.5, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.45 }}>{q.question}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(q.options ?? []).map((o, oi) => {
                const label = optionLabel(o);
                const desc = optionDesc(o);
                const isSel = chosen.includes(label);
                return (
                  <button key={oi} onClick={() => pick(qi, label, multi)} disabled={submitted} style={optionStyle(isSel)}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {marker(isSel)}
                      <span style={{ fontWeight: 500 }}>{label}</span>
                    </span>
                    {desc && <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', paddingLeft: 23, lineHeight: 1.4 }}>{desc}</span>}
                  </button>
                );
              })}
              <button onClick={() => toggleOther(qi, multi)} disabled={submitted} style={optionStyle(otherOn)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {marker(otherOn)}
                  <span style={{ fontWeight: 500 }}>Other</span>
                </span>
              </button>
              {otherOn && (
                <input
                  aria-label={`Other answer for ${q.header ?? q.question}`}
                  autoFocus
                  value={other[qi] ?? ''}
                  disabled={submitted}
                  onChange={(e) => { const v = e.target.value; setOther((prev) => ({ ...prev, [qi]: v })); }}
                  placeholder="Type your answer"
                  style={{ border: '1px solid var(--color-border)', borderRadius: 9, padding: '8px 12px', background: 'var(--color-base)', color: 'var(--color-text-primary)', font: '400 14px var(--font-sans)' }}
                />
              )}
            </div>
          </div>
        );
      })}
      {discussOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            aria-label="Discuss the question"
            autoFocus
            rows={2}
            value={discussText}
            onChange={(e) => setDiscussText(e.target.value)}
            placeholder="Say what you think, or leave empty to ask for more context"
            style={{ border: '1px solid var(--color-border)', borderRadius: 9, padding: '8px 12px', background: 'var(--color-base)', color: 'var(--color-text-primary)', font: '400 14px var(--font-sans)', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={sendDiscuss} style={actionStyle}>Send</button>
            <button onClick={() => { setDiscussOpen(false); setDiscussText(''); }} style={actionStyle}>Cancel</button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <button
          onClick={submit}
          disabled={submitted || !allAnswered}
          style={{
            border: 'none', borderRadius: 6, height: 30, padding: '0 16px', fontWeight: 600, fontSize: 12.5,
            background: allAnswered && !submitted ? 'var(--color-accent)' : 'var(--color-hover)',
            color: allAnswered && !submitted ? '#06140B' : 'var(--color-text-tertiary)',
            cursor: allAnswered && !submitted ? 'pointer' : 'default', transition: 'background .15s',
          }}
        >
          {submitted ? 'Sent' : 'Submit'}
        </button>
        {(onReply || onDeny) && !discussOpen && (
          <button onClick={() => setDiscussOpen(true)} disabled={submitted} style={actionStyle}>Discuss</button>
        )}
        {onDeny && (
          <button onClick={() => deny('dismiss')} disabled={submitted} style={actionStyle}>Dismiss</button>
        )}
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>or reply below to discuss</span>
      </div>
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
 * Which option labels does an answer string select? NOT a bare `split(', ')`: a single-select
 * answer whose label itself contains a comma — "No, visual redesign only" — used to split into
 * two bogus labels and match nothing, so the answered card showed the user's choice as
 * unselected (reported 2026-08-16). Exact-match first; then a greedy parse of the multi-select
 * `", "`-joined shape that only ever consumes WHOLE known labels, so comma-bearing labels
 * survive inside a join too. Returns null when nothing parses — a free-text "Other" answer —
 * and the caller then shows the raw answer text instead of a silently unmarked option list.
 */
export function selectedOptionLabels(answer: string, labels: string[]): Set<string> | null {
  if (labels.includes(answer)) return new Set([answer]);
  const sel = new Set<string>();
  let rest = answer;
  outer: while (rest.length > 0) {
    for (const l of labels) {
      if (rest === l) { sel.add(l); return sel; }
      if (l && rest.startsWith(l + ', ')) { sel.add(l); rest = rest.slice(l.length + 2); continue outer; }
    }
    return null;
  }
  return sel.size > 0 ? sel : null;
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
  // A chat reply answers every question at once, in the user's own words.
  const chatReply = parseQuestionReply(resultText);
  const replyText = chatReply ? (chatReply.imageOnly ? '(an image)' : chatReply.reply) : null;
  const parsed = chatReply ? null : parseAnsweredResult(resultText, questions);
  const first = questions[0];
  const firstAnswer = replyText != null ? `answered in chat: ${replyText}` : (first && parsed?.[first.question]) || resultText;

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
          {replyText != null && (
            <div style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
              <span style={{ color: 'var(--color-text-tertiary)' }}>answered in chat: </span>{replyText}
            </div>
          )}
          {questions.map((q, qi) => {
            const answer = q.question ? parsed?.[q.question] : undefined;
            const labels = (q.options ?? []).map(optionLabel);
            const chosenSet = answer != null ? selectedOptionLabels(answer, labels) : null;
            const chosen = chosenSet ? [...chosenSet] : [];
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
                {answer == null && replyText == null && (
                  <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>{resultText}</div>
                )}
                {/* A free-text "Other" answer matches no option — show it verbatim instead of
                    presenting an all-unselected list that looks like nothing was chosen. */}
                {answer != null && chosenSet == null && (
                  <div style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
                    <span style={{ color: 'var(--color-text-tertiary)' }}>answered: </span>{answer}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
