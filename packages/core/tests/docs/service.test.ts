import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { EndlessStore } from '../../src/endless/store.js';
import { DocsService, DocTimeoutError, DOC_CONCURRENCY, DOC_DEADLINE_MS } from '../../src/docs/service.js';
import { DOCS_CACHE_MS } from '../../src/docs/list.js';
import { makeRepo } from './git-fixture.js';

let r: ReturnType<typeof makeRepo>;
let db: Database.Database;
let store: EndlessStore;
let wt: string;
let t = 0;
const now = () => t;

beforeEach(() => {
  t = 1_000_000;
  r = makeRepo();
  r.write('README.md', 'x'); r.commit('init');
  wt = path.join(r.dir, '.worktrees', 'a');
  r.g(r.dir, 'worktree', 'add', '-q', '-b', 'spec/a', wt);
  r.write('docs/specs/one.md', '1', wt);
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'studio', workingDir: r.dir });
  store = new EndlessStore(db);
});
afterEach(() => r.rm());

describe('DocsService.list', () => {
  it('keeps a value for 60 s, then computes it again', async () => {
    const svc = new DocsService(db, store, now);
    expect((await svc.list('s1'))!.total).toBe(1);
    r.write('docs/specs/two.md', '2', wt);
    t += DOCS_CACHE_MS - 1;
    expect((await svc.list('s1'))!.total).toBe(1);
    t += 2;
    expect((await svc.list('s1'))!.total).toBe(2);
    expect(await svc.list('nope')).toBeNull();
  });
});

describe('DocsService.counts', () => {
  it('answers a stale value at once and refreshes it once in the background', async () => {
    let total = 1;
    const pending: (() => void)[] = [];
    const lister = vi.fn(async () => {
      const v = total;
      if (lister.mock.calls.length > 1) await new Promise<void>((res) => pending.push(res));
      return { rows: [], total: v };
    });
    const svc = new DocsService(db, store, now, lister);
    expect(await svc.counts(['s1', 'nope'])).toEqual({ s1: 1 });
    expect(lister).toHaveBeenCalledTimes(1);
    total = 2;
    t += DOCS_CACHE_MS + 1;
    expect(await svc.counts(['s1'])).toEqual({ s1: 1 }); // stale, at once
    expect(await svc.counts(['s1'])).toEqual({ s1: 1 }); // still stale: no second refresh
    expect(lister).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(1);
    const listed = svc.list('s1'); // waits for the refresh that runs, does not start a second
    pending[0]();
    expect((await listed)!.total).toBe(2);
    await vi.waitFor(async () => expect(await svc.counts(['s1'])).toEqual({ s1: 2 }));
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it('computes the projects with no value at most 3 at a time, before the answer', async () => {
    for (const id of ['s2', 's3', 's4', 's5']) sessionsDb.create(db, { id, provider: 'claude-code', name: 'rollup', workingDir: r.dir });
    let active = 0;
    let most = 0;
    const lister = vi.fn(async () => {
      active++; most = Math.max(most, active);
      await new Promise((res) => setTimeout(res, 5));
      active--;
      return { rows: [], total: 3 };
    });
    const svc = new DocsService(db, store, now, lister);
    expect(await svc.counts(['s1', 's2', 's3', 's4', 's5'])).toEqual({ s1: 3, s2: 3, s3: 3, s4: 3, s5: 3 });
    expect(lister).toHaveBeenCalledTimes(5);
    expect(most).toBe(3);
  });

  it('two concurrent counts for a project with no value run the lister once', async () => {
    const releases: (() => void)[] = [];
    const lister = vi.fn(async () => { await new Promise<void>((res) => releases.push(res)); return { rows: [], total: 4 }; });
    const svc = new DocsService(db, store, now, lister);
    const a = svc.counts(['s1']);
    const b = svc.counts(['s1']);
    const c = svc.list('s1');
    await vi.waitFor(() => expect(lister).toHaveBeenCalled());
    for (const f of releases) f();
    expect(await a).toEqual({ s1: 4 });
    expect(await b).toEqual({ s1: 4 });
    expect((await c)!.total).toBe(4);
    expect(lister).toHaveBeenCalledTimes(1);
  });
});

describe('DocsService writer', () => {
  const writer = async (svc: DocsService) => (await svc.list('s1'))!.rows[0].writer;

  it('is a live thread working in the worktree; an archived one is not', async () => {
    terminalsDb.create(db, { id: 't-old', sessionId: 's1', type: 'claude-code', label: 'Old', workingDir: wt });
    terminalsDb.archive(db, 't-old');
    const svc = new DocsService(db, store, now);
    expect(await writer(svc)).toBeNull();
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Plan: one', workingDir: path.join(wt, 'docs') });
    t += DOCS_CACHE_MS + 1;
    expect(await writer(svc)).toEqual({ id: 't1', label: 'Plan: one' });
  });

  it('a thread whose folder is gone is not the writer', async () => {
    terminalsDb.create(db, { id: 't-gone', sessionId: 's1', type: 'claude-code', label: 'Gone', workingDir: path.join(fs.realpathSync.native(wt), 'gone') });
    expect(await writer(new DocsService(db, store, now))).toBeNull();
  });

  it('with no thread in the worktree, the newest Chat work report that names the path gives the writer', async () => {
    terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'claude-code', label: 'Spec: early' });
    terminalsDb.create(db, { id: 't3', sessionId: 's1', type: 'claude-code', label: 'Spec: late' });
    const line = `Doc: ${path.join(wt, 'docs/specs/one.md')} (branch spec/a)`;
    store.append({ kind: 'work', text: line, project: 's1', ref: 't2' });
    store.append({ kind: 'work', text: line, project: 's1', ref: 't3' });
    store.append({ kind: 'work', text: 'no doc here', project: 's1', ref: 't2' });
    expect(await writer(new DocsService(db, store, now))).toEqual({ id: 't3', label: 'Spec: late' });
  });
});

describe('DocsService.doc', () => {
  it('passes the branch and the worktree path to the resolver; null for an unknown project', async () => {
    r.write('docs/specs/one.md', 'main'); r.commit('main copy');
    r.write('docs/specs/one.md', 'wt', wt);
    const svc = new DocsService(db, store, now);
    const d = await svc.doc('s1', 'docs/specs/one.md', null, '.worktrees/a');
    expect(d).toMatchObject({ kind: 'doc', doc: { source: 'worktree', worktree: 'a', worktreeRel: '.worktrees/a', markdown: 'wt' } });
    expect(await svc.doc('s1', 'docs/specs/one.md', null, 'a')).toMatchObject({ kind: 'doc', doc: { source: 'worktree', markdown: 'wt' } });
    expect(await svc.doc('s1', 'docs/specs/one.md', 'spec/a')).toMatchObject({ kind: 'doc', doc: { source: 'worktree', markdown: 'wt' } });
    expect(await svc.doc('s1', 'docs/specs/one.md', null)).toMatchObject({ kind: 'doc', doc: { source: 'main', markdown: 'main' } });
    expect(await svc.doc('nope', 'docs/specs/one.md', null, 'a')).toBeNull();
  });

  it('runs at most 4 resolutions at once; the rest wait their turn', async () => {
    let active = 0;
    let most = 0;
    const resolver = vi.fn(async () => {
      active++; most = Math.max(most, active);
      await new Promise((res) => setTimeout(res, 10));
      active--;
      return { kind: 'not_found' as const, looked: [] };
    });
    const svc = new DocsService(db, store, now, undefined, { resolver });
    const all = await Promise.all(Array.from({ length: 6 }, (_, k) => svc.doc('s1', `docs/specs/d${k}.md`, null)));
    expect(all).toHaveLength(6);
    for (const x of all) expect(x).toEqual({ kind: 'not_found', looked: [] });
    expect(resolver).toHaveBeenCalledTimes(6);
    expect(most).toBe(DOC_CONCURRENCY);
    expect(DOC_CONCURRENCY).toBe(4);
  });

  it('a resolution that takes longer than the deadline fails with DocTimeoutError', async () => {
    expect(DOC_DEADLINE_MS).toBe(3000);
    const resolver = vi.fn(() => new Promise<never>(() => { /* never settles */ }));
    const svc = new DocsService(db, store, now, undefined, { resolver, deadlineMs: 50 });
    const started = Date.now();
    const calls = Array.from({ length: 5 }, () => svc.doc('s1', 'docs/specs/one.md', null));
    for (const c of calls) await expect(c).rejects.toBeInstanceOf(DocTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('a lookup queued behind the full semaphore whose deadline passed never calls its resolver', async () => {
    // Each resolver settles AFTER the deadline, so the slots free late and the queued 5th gets its turn too late.
    const resolver = vi.fn(() => new Promise<never>((_, rej) => setTimeout(() => rej(new Error('late')), 150)));
    const svc = new DocsService(db, store, now, undefined, { resolver, deadlineMs: 50 });
    const calls = Array.from({ length: 5 }, () => svc.doc('s1', 'docs/specs/one.md', null));
    for (const c of calls) await expect(c).rejects.toBeInstanceOf(DocTimeoutError);
    await new Promise((res) => setTimeout(res, 300)); // past the slots freeing
    expect(resolver).toHaveBeenCalledTimes(4);
  });
});
