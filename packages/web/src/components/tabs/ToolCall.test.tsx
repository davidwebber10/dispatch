import { describe, it, expect } from 'vitest';
import { inputSummary, editDiffStat, toolGlyph } from './ToolCall';

// A raw JSON input used to render verbatim in the machinery row ("often times an input
// command will be a JSON object" — David, 2026-08-16). inputSummary turns it into
// readable `key: value` pairs; non-JSON details pass through.
describe('inputSummary', () => {
  it('renders a JSON object input as key: value pairs, salient keys first', () => {
    const s = inputSummary({ toolInput: JSON.stringify({ limit: 5, query: 'polywood sales' }) });
    expect(s).toBe('query: polywood sales · limit: 5');
  });

  it('passes a non-JSON detail (Bash command) through untouched', () => {
    expect(inputSummary({ toolDetail: 'git status --porcelain', toolInput: '{"command":"git status --porcelain"}' })).toBe('git status --porcelain');
  });

  it('replaces a JSON-ish detail with the parsed summary', () => {
    const s = inputSummary({ toolDetail: '{"url":"https://x.dev"}', toolInput: '{"url":"https://x.dev"}' });
    expect(s).toBe('url: https://x.dev');
  });

  it('skips nested objects, truncates long values, caps at three pairs', () => {
    const s = inputSummary({ toolInput: JSON.stringify({ a: 'x'.repeat(120), nested: { deep: 1 }, b: 2, c: 3, d: 4 }) })!;
    expect(s).not.toContain('nested');
    expect(s).toContain('…');
    expect(s.split(' · ')).toHaveLength(3);
  });

  it('returns undefined when there is nothing usable', () => {
    expect(inputSummary({ toolInput: '' })).toBeUndefined();
    expect(inputSummary({ toolInput: JSON.stringify({ only: { nested: true } }) })).toBeUndefined();
  });
});

describe('editDiffStat / toolGlyph', () => {
  it('counts an Edit input as +new −old lines', () => {
    expect(editDiffStat('Edit', JSON.stringify({ old_string: 'a\nb', new_string: 'a\nb\nc' }))).toEqual({ add: 3, del: 2 });
  });
  it('a Write is all additions; unparseable input yields null', () => {
    expect(editDiffStat('Write', JSON.stringify({ content: 'x\ny' }))).toEqual({ add: 2, del: 0 });
    expect(editDiffStat('Edit', 'not json')).toBeNull();
  });
  it('maps tool families to glyphs', () => {
    expect(toolGlyph('Bash')).toBe('$');
    expect(toolGlyph('Read')).toBe('≡');
    expect(toolGlyph('mcp__databricks__databricks_query')).toBe('⚙');
  });
});
