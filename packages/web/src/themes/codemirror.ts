import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/**
 * The file editor's CodeMirror theme, from the theme tokens (CSS variables), so the editor follows
 * a theme change without a rebuild. Same structure as One Dark (which it replaced): the colors map to
 * the --syntax-* and surface tokens.
 */
const theme = EditorView.theme({
  '&': { color: 'var(--syntax-text)', backgroundColor: 'var(--color-terminal)' },
  '.cm-content': { caretColor: 'var(--color-accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--color-selection)' },
  '.cm-panels': { backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-primary)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--color-border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--color-border)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--syntax-function) 35%, transparent)', outline: '1px solid var(--syntax-function)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--syntax-function) 18%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-text-emphasis) 4%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'color-mix(in srgb, var(--syntax-function) 28%, transparent)' },
  '.cm-gutters': { backgroundColor: 'var(--color-terminal)', color: 'var(--color-text-tertiary)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-hover)' },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: 'var(--color-text-secondary)' },
  '.cm-tooltip': { border: '1px solid var(--color-border)', backgroundColor: 'var(--color-elevated)' },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--color-elevated)', borderBottomColor: 'var(--color-elevated)' },
  '.cm-tooltip-autocomplete': { '& > ul > li[aria-selected]': { backgroundColor: 'var(--color-hover)', color: 'var(--color-text-primary)' } },
});

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: 'var(--syntax-tag)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--syntax-function)' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: 'var(--syntax-number)' },
  { tag: [tags.definition(tags.name), tags.separator], color: 'var(--syntax-text)' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: 'var(--syntax-class)' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: 'var(--syntax-literal)' },
  { tag: [tags.meta, tags.comment], color: 'var(--syntax-comment)' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--syntax-comment)', textDecoration: 'underline' },
  { tag: tags.heading, fontWeight: 'bold', color: 'var(--syntax-tag)' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: 'var(--syntax-number)' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: 'var(--syntax-string)' },
  { tag: tags.invalid, color: 'var(--color-status-red)' },
]);

export const tokenEditorTheme = [theme, syntaxHighlighting(highlight)];
