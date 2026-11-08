import { describe, it, expect } from 'vitest';
// The bundled Previews plugin is plain JS; its filter is a named export beside activate().
import { filterPreviews, projectsWithPreviews, threadsWithPreviews } from '../../../plugins/previews/web.js';

const p = (id: string, over: Record<string, unknown> = {}) => ({ id, sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Fix login', title: `T ${id}`, note: null, text: null, files: [], createdAt: '2026-11-07T10:00:00Z', seenAt: null, ...over });
const items = [
  p('a', { title: 'Login page screenshot', files: [{ name: 'shot.png', mime: 'image/png', size: 1, fileId: 'f' }] }),
  p('b', { sessionId: 's2', sessionName: 'Beta', terminalId: 't2', terminalLabel: 'Release', title: 'Release notes', note: 'For v3.28', text: 'npm run release' }),
  p('c', { sessionId: 's2', sessionName: 'Beta', terminalId: 't3', terminalLabel: 'Charts', title: 'Chart', files: [{ name: 'usage-chart.svg', mime: 'image/svg+xml', size: 1, fileId: 'g' }] }),
];
const nameOf = (id: string) => ({ s1: 'Alpha', s2: 'Beta' } as Record<string, string>)[id];

describe('Previews history: filter by project and search (2026-11-07)', () => {
  it('a project keeps only its previews; no project keeps all', () => {
    expect(filterPreviews(items, { project: 's2', query: '' }).map((x) => x.id)).toEqual(['b', 'c']);
    expect(filterPreviews(items, { project: null, query: '' }).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('the search matches the title, the note, the text, a file name, the thread and the project, without case', () => {
    expect(filterPreviews(items, { project: null, query: 'login' }).map((x) => x.id)).toEqual(['a']);
    expect(filterPreviews(items, { project: null, query: 'V3.28' }).map((x) => x.id)).toEqual(['b']);
    expect(filterPreviews(items, { project: null, query: 'npm run' }).map((x) => x.id)).toEqual(['b']);
    expect(filterPreviews(items, { project: null, query: 'chart.svg' }).map((x) => x.id)).toEqual(['c']);
    expect(filterPreviews(items, { project: null, query: 'release' }).map((x) => x.id)).toEqual(['b']);
    expect(filterPreviews(items, { project: null, query: 'beta' }, nameOf).map((x) => x.id)).toEqual(['b', 'c']);
    expect(filterPreviews(items, { project: 's1', query: 'release' })).toEqual([]);
  });
  it('the project choices are the projects that have previews, with counts, by name', () => {
    expect(projectsWithPreviews(items, nameOf)).toEqual([{ id: 's1', name: 'Alpha', count: 1 }, { id: 's2', name: 'Beta', count: 2 }]);
  });

  it('a source thread keeps only its previews; the thread choices follow the chosen project', () => {
    expect(filterPreviews(items, { project: null, thread: 't3', query: '' }).map((x) => x.id)).toEqual(['c']);
    expect(filterPreviews(items, { project: 's2', thread: 't2', query: 'chart' })).toEqual([]);
    expect(threadsWithPreviews(items, null)).toEqual([{ id: 't3', label: 'Charts', count: 1 }, { id: 't1', label: 'Fix login', count: 1 }, { id: 't2', label: 'Release', count: 1 }]);
    expect(threadsWithPreviews(items, 's2').map((t) => t.id)).toEqual(['t3', 't2']);
  });
});

describe('Previews leaves the thread header alone (2026-11-07)', () => {
  it('registers no thread header button: a thread reaches its previews from the shelf and the thread menu', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../../plugins/previews/web.js'), 'utf8');
    expect(src).not.toContain("slot: 'thread.header.actions'");
    expect(src).toContain("slot: 'project.header.actions'");
  });
});

describe('Previews images load inside the sheet (2026-11-07)', () => {
  it('no lazy-loaded image: Safari never starts a lazy image inside the sliding sheet, so every square stayed blank', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../../plugins/previews/web.js'), 'utf8');
    expect(src).not.toContain("loading: 'lazy'");
    expect(src).toContain("decoding: 'async'");
  });
});
