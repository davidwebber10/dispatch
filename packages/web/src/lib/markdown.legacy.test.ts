// The HTML of a finished message is the HTML that the app gave before W2-E (engineering program
// 2026-11-09). `legacy` below is the parser as lib/markdown.ts built it before the split: one
// highlight.js instance with all sixteen languages registered at load. Each fixture goes through
// both, after the lazy languages are in.
import { beforeAll, describe, expect, it } from 'vitest';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import HighlightJS from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import plaintext from 'highlight.js/lib/languages/plaintext';
import { highlightCode, langFromPath, renderMarkdown } from './markdown';
import { loadAllLanguages } from './highlight';

const old = HighlightJS.newInstance();
for (const [name, fn] of Object.entries({ javascript, typescript, json, python, bash, css, xml, yaml, markdown, sql, go, rust, diff, ini, dockerfile, plaintext })) old.registerLanguage(name, fn);
old.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
old.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
old.registerAliases(['sh', 'zsh', 'shell', 'console'], { languageName: 'bash' });
old.registerAliases(['html', 'htm', 'svg', 'vue'], { languageName: 'xml' });
old.registerAliases(['yml'], { languageName: 'yaml' });
old.registerAliases(['py'], { languageName: 'python' });
old.registerAliases(['md'], { languageName: 'markdown' });
old.registerAliases(['golang'], { languageName: 'go' });
old.registerAliases(['rs'], { languageName: 'rust' });
old.registerAliases(['docker'], { languageName: 'dockerfile' });
old.registerAliases(['toml', 'conf'], { languageName: 'ini' });
old.registerAliases(['text', 'txt'], { languageName: 'plaintext' });

const legacy = new Marked(
  { gfm: true, breaks: false },
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && old.getLanguage(lang) ? lang : 'plaintext';
      try { return old.highlight(code, { language }).value; } catch { return code; }
    },
  }),
);
const legacyHighlightCode = (code: string, lang?: string): string => {
  if (lang && old.getLanguage(lang)) return old.highlight(code, { language: lang }).value;
  return old.highlightAuto(code).value;
};

const CODE: Record<string, string> = {
  javascript: 'const a = 1; // note\nexport default function App() { return <div className="x">{a}</div>; }',
  jsx: 'const el = <a href="/x">go</a>;',
  typescript: 'interface A { b: string }\nconst x: A = { b: `t${1}` };',
  tsx: 'export const C = (p: { n: number }) => <span>{p.n}</span>;',
  json: '{ "a": [1, true, null], "b": "c" }',
  python: 'def f(x):\n    """doc"""\n    return x + 1  # note',
  py: 'print(f"{x!r}")',
  bash: 'for f in *.md; do echo "$f" | wc -l; done',
  sh: 'export A=1 && ./run.sh --flag',
  console: '$ npm test',
  css: '.a > b:hover { color: var(--x); margin: 0 4px; }',
  xml: '<a b="c"><!-- d --><e/></a>',
  html: '<!doctype html><html><body class="x"><script>let a = 1;</script><style>.a{b:c}</style></body></html>',
  yaml: 'a:\n  - b: 1\n    c: "d" # e',
  yml: 'on: [push]',
  markdown: '# Title\n\n- *a* **b** `c` [d](e)\n\n<b>raw</b>',
  md: '> quote',
  sql: "SELECT a, count(*) FROM t WHERE b = 'c' GROUP BY 1;",
  go: 'package main\n\nfunc main() { fmt.Println("x") }',
  golang: 'var a int = 1',
  rust: 'fn main() { let x: u8 = 1; println!("{}", x); }',
  rs: 'struct A;',
  diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
  ini: '[a]\nb = c ; d',
  toml: 'a = "b"\n[c]\nd = 1',
  conf: 'key value',
  dockerfile: 'FROM node:20\nRUN npm ci\nCMD ["node", "x.js"]',
  docker: 'COPY . .',
  plaintext: 'just <text> & more',
  text: 'a < b',
  '': 'no language at all <b>',
  klingon: 'an unknown language',
};

const DOCS: Record<string, string> = {
  prose: '# Title\n\nA paragraph with **bold**, *em*, ~~strike~~, `code` and a [link](https://example.com/a "t").\n\nSecond paragraph\nwith a soft break.\n',
  lists: '- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done\n',
  table: '| Measure | Before | After |\n|:--|--:|:-:|\n| Page | 300 ms | 4 ms |\n| `x` | **y** | [z](https://example.com) |\n',
  links: 'See <https://example.com/auto>, https://example.com/bare, [ref][r] and [doc](docs/plan.md:12).\n\n[r]: https://example.com/ref\n',
  images: '![chart](/a.png) ![remote](https://example.com/x.png "title") [![linked](/b.png)](https://example.com)\n',
  html: 'Text <b>bold</b> <span style="color:red">x</span>\n\n<details><summary>s</summary>\n\nbody\n\n</details>\n',
  quoteAndRule: '> quote\n> more\n\n---\n\nAfter.\n',
  everyCodeBlock: Object.entries(CODE).map(([lang, code]) => '```' + lang + '\n' + code + '\n```').join('\n\ntext between\n\n'),
  indentedCode: 'Text.\n\n    indented code <b>\n\nEnd.\n',
};

describe('the HTML equals the HTML before the split, once the languages are in', () => {
  beforeAll(async () => { expect(await loadAllLanguages()).toBe(true); });

  for (const [name, text] of Object.entries(DOCS)) {
    it(`renderMarkdown: ${name}`, () => { expect(renderMarkdown(text)).toBe(legacy.parse(text)); });
  }

  for (const [lang, code] of Object.entries(CODE)) {
    it(`highlightCode with the language "${lang}"`, () => { expect(highlightCode(code, lang || undefined)).toBe(legacyHighlightCode(code, lang || undefined)); });
  }

  it('highlightCode with no language auto-detects over the same languages', () => {
    for (const code of Object.values(CODE)) expect(highlightCode(code)).toBe(legacyHighlightCode(code));
  });

  it('langFromPath is unchanged for each extension the tool views use', () => {
    const want: Record<string, string | undefined> = { 'a.ts': 'typescript', 'a.tsx': 'typescript', 'a.py': 'python', 'a.sh': 'bash', 'a.sql': 'sql', 'a.html': 'xml', 'a.yml': 'yaml', 'a.md': 'markdown', 'a.go': 'go', 'a.rs': 'rust', 'a.toml': 'ini', 'Dockerfile.dockerfile': 'dockerfile', 'a.patch': 'diff', 'a.unknown': undefined };
    for (const [file, lang] of Object.entries(want)) expect(langFromPath(file)).toBe(lang);
  });
});
