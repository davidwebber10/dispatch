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

import { useState } from 'react';
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
 * The agent chat's insight treatment (2026-08-16 pretty-chat redesign): a left-railed block —
 * mono letterspaced INSIGHT header with a rotating caret, italic dim body clamped to 2 lines,
 * click anywhere to expand. Deliberately quieter than the coordinator's tinted callout: in a
 * thread the insight is an aside to the work, not a headline.
 */
function InsightRail({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    // Accent left rail + a faint accent wash ("insight needs visual distinction" — David):
    // still quieter than the coordinator's callout card, but unmistakably not prose.
    <div
      data-testid="insight-rail"
      onClick={() => setOpen((o) => !o)}
      style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 12px 8px 13px', borderLeft: '2px solid color-mix(in srgb, var(--color-accent) 55%, transparent)', borderRadius: '0 8px 8px 0', background: 'color-mix(in srgb, var(--color-accent) 5%, transparent)', cursor: 'pointer', minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Lightbulb size={12} weight="fill" color="var(--color-accent)" style={{ flex: 'none' }} />
        <span style={{ font: '500 9.5px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-accent)' }}>INSIGHT</span>
        <span aria-hidden style={{ font: '400 9px var(--font-mono)', color: 'var(--color-text-tertiary)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.7,
          fontStyle: 'italic',
          color: 'var(--color-text-secondary)',
          minWidth: 0,
          // -webkit-box line clamping works on the markdown container's rendered lines;
          // expanded removes the clamp entirely rather than raising it.
          ...(open ? {} : { display: '-webkit-box', WebkitBoxOrient: 'vertical' as const, WebkitLineClamp: 2, overflow: 'hidden' }),
        }}
      >
        <Markdown source={content} />
      </div>
    </div>
  );
}

/**
 * Render assistant text: prose through <Markdown>, any ★ Insight blocks lifted into tinted
 * callouts. `scheme` selects the token set (default 'scoped' for the coordinator surface);
 * `variant="rail"` (agent chat) swaps the callout for the clamped left-rail block.
 */
export function InsightText({ source, scheme = 'scoped', variant = 'callout' }: { source: string; scheme?: Scheme; variant?: 'callout' | 'rail' }) {
  const segs = splitInsights(source);
  if (segs.length === 0) return null; // all-blank body → nothing to render
  const tokens = SCHEMES[scheme];
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {segs.map((seg, i) =>
        seg.type === 'insight' ? (
          variant === 'rail' ? <InsightRail key={i} content={seg.content} /> : <InsightCallout key={i} content={seg.content} tokens={tokens} />
        ) : (
          <Markdown key={i} source={seg.content} />
        ),
      )}
    </div>
  );
}
