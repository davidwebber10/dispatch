export interface AskOption { label: string; description?: string; preview?: string; }
export interface AskQuestion { question: string; header?: string; multiSelect?: boolean; options: AskOption[]; }

const DOWN = '\x1b[B';
const ENTER = '\r';
const SPACE = ' ';

export function buildAnswerInput(questions: AskQuestion[], selections: number[][]): string {
  let out = '';
  questions.forEach((q, qi) => {
    const sel = (selections[qi] ?? []).slice().sort((a, b) => a - b);
    if (q.multiSelect) {
      const max = sel.length ? sel[sel.length - 1] : -1;
      for (let idx = 0; idx <= max; idx++) {
        if (idx > 0) out += DOWN;
        if (sel.includes(idx)) out += SPACE;
      }
      out += ENTER;
    } else {
      const idx = sel.length ? sel[0] : 0;
      out += DOWN.repeat(idx) + ENTER;
    }
  });
  return out;
}

export function parseQuestions(toolInput: string | undefined): AskQuestion[] {
  if (!toolInput) return [];
  try {
    const v = JSON.parse(toolInput);
    const qs = v?.questions;
    if (!Array.isArray(qs)) return [];
    return qs
      .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options))
      .map((q) => ({
        question: String(q.question),
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect === true,
        options: q.options
          .filter((o: unknown) => o && typeof (o as AskOption).label === 'string')
          .map((o: AskOption) => ({ label: String(o.label), description: o.description, preview: o.preview })),
      }));
  } catch {
    return [];
  }
}
