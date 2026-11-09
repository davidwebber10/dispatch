// packages/web/scripts/perf/stream-fixture.mjs
// One long assistant reply (about 4,000 tokens) for the streamed-markdown measurements (W2-E, plan 1A.3).
// The same text feeds the vitest measurement (markdown-stream.perf.test.tsx) and the browser one (load-perf.mjs).
const SECTION = (n) => `## Step ${n}: read the transcript in pages

The reader opens the file once and keeps the **byte offset** of each page. A page is \`200\` items. See
[the plan](https://example.com/plan#step-${n}) and \`docs/plan-${n}.md\` for the reasons.

- It never reads the full file.
- It keeps one small buffer for each open thread.
- A page that ends inside a line is extended to the next line break.

\`\`\`ts
export async function readPage${n}(file: string, from: number, size = 200): Promise<Page> {
  const handle = await fs.open(file, 'r');
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, from);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\\n');
    return { items: lines.slice(0, size).map(parseLine), next: from + bytesRead };
  } finally {
    await handle.close();
  }
}
\`\`\`

| Measure | Before | After |
|---|---:|---:|
| Page time | ${300 + n} ms | ${4 + n} ms |
| Event-loop delay | ${310 + n} ms | 2 ms |

> A page read must not stop the socket of a second thread.

`;

/** The full reply text. About 16,000 characters. */
export function streamFixture(sections = 16) {
  let out = 'Here is the plan for the transcript reader.\n\n';
  for (let i = 1; i <= sections; i++) out += SECTION(i);
  return out + 'That is the full plan.\n';
}

/** The reply cut into deltas of about one token (4 characters). */
export function streamDeltas(text = streamFixture(), size = 4) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}
