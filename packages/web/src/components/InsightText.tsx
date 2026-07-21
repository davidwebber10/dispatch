// Shared assistant-text renderer with ★ Insight callouts.
//
// Both the coordinator stream (OverseerMsg) and the agent chat (AssistantText) render the
// SAME assistant prose, some of which embeds an "insight" block delimited by a star-headed
// opener line and a closing rule of dashes. Claude often fences the delimiter lines as inline
// code, so the opener/closer arrive wrapped in backticks:
//   `★ Insight ─────────────────────────────────────`
//   …content…
//   `─────────────────────────────────────────────────`
// Rendered verbatim those are just literal rows of dashes in the markdown. splitInsights()
// walks the text into prose / insight segments (frontend-only — the upstream text is
// untouched); each insight run becomes a tinted lightbulb callout while every non-insight
// run still flows through the shared <Markdown>. Routing BOTH surfaces through this one
// component keeps insight rendering identical across the coordinator and its subagents.
//
// Themeable via `scheme` (mirrors AutonomyControls): 'scoped' reads the overseer-root
// --acc/--accLine/--accDim tokens; 'global' reads the app-wide --color-* tokens (the tint /
// line are mixed from --color-accent, matching the codebase's other color-mix accents).

import { Lightbulb } from '@phosphor-icons/react';
import { Markdown } from './Markdown';

// Opener: "★ Insight" + trailing dashes (box-drawing, em/en dash, hyphen), optionally wrapped
// in backticks (Claude fences the delimiter lines as inline code, e.g. `★ Insight ───`).
const INSIGHT_OPEN = /^\s*`?\s*★\s*Insight[\s─—–-]*`?\s*$/;
// A closing (or separating) rule: 3+ dashes, optionally backtick-wrapped.
const RULE_LINE = /^\s*`?\s*[─—–-]{3,}\s*`?\s*$/;

type InsightSeg = { type: 'md' | 'insight'; content: string };

/** Split assistant text into ordered prose / insight segments (frontend-only). */
export function splitInsights(text: string): InsightSeg[] {
  const lines = text.split('\n');
  const out: InsightSeg[] = [];
  let md: string[] = [];
  const flushMd = () => {
    const content = md.join('\n');
    if (content.trim()) out.push({ type: 'md', content }); // drop blank gaps around a callout
    md = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (INSIGHT_OPEN.test(lines[i])) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !RULE_LINE.test(lines[j]); j++) body.push(lines[j]);
      flushMd();
      out.push({ type: 'insight', content: body.join('\n').trim() });
      i = j; // skip past the closing rule (or land on EOF when the block was unterminated)
    } else {
      md.push(lines[i]);
    }
  }
  flushMd();
  return out;
}

type Scheme = 'scoped' | 'global';
interface Tokens { accent: string; line: string; dim: string; }

const SCHEMES: Record<Scheme, Tokens> = {
  scoped: { accent: 'var(--acc)', line: 'var(--accLine)', dim: 'var(--accDim)' },
  global: {
    accent: 'var(--color-accent)',
    line: 'color-mix(in srgb, var(--color-accent) 40%, transparent)',
    dim: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
  },
};

function InsightCallout({ content, tokens }: { content: string; tokens: Tokens }) {
  return (
    <div
      style={{
        borderRadius: 9,
        border: `1px solid ${tokens.line}`,
        background: tokens.dim,
        padding: '8px 13px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {/* subtle "Insight" label with a lightbulb accent */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Lightbulb size={13} weight="fill" color={tokens.accent} style={{ flex: 'none' }} />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: tokens.accent,
          }}
        >
          Insight
        </span>
      </div>
      {/* enclosed content — still markdown, so lists/code inside a callout render normally */}
      <div style={{ minWidth: 0 }}>
        <Markdown source={content} />
      </div>
    </div>
  );
}

/**
 * Render assistant text: prose through <Markdown>, any ★ Insight blocks lifted into tinted
 * callouts. `scheme` selects the token set (default 'scoped' for the coordinator surface).
 */
export function InsightText({ source, scheme = 'scoped' }: { source: string; scheme?: Scheme }) {
  const segs = splitInsights(source);
  if (segs.length === 0) return null; // all-blank body → nothing to render
  const tokens = SCHEMES[scheme];
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {segs.map((seg, i) =>
        seg.type === 'insight' ? (
          <InsightCallout key={i} content={seg.content} tokens={tokens} />
        ) : (
          <Markdown key={i} source={seg.content} />
        ),
      )}
    </div>
  );
}
