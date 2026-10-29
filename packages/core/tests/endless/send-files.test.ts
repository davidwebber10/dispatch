import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { EndlessService, safeFileName } from '../../src/endless/service.js';
import { FakeSummarizer, settle } from './fake-summarizer.js';
import { FakeManager } from './fake-manager.js';

let root: string;
let db: Database.Database;
let svc: EndlessService;
let fake: FakeManager;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-files-'));
  db = new Database(':memory:');
  initSchema(db);
  fake = new FakeManager();
  svc = new EndlessService({
    db, broadcaster: { broadcast: () => {} }, manager: fake.asManager(),
    chatDir: path.join(root, 'chat'), home: path.join(root, 'home'), summarizer: new FakeSummarizer(),
    timeZone: 'UTC', turn: { waitMs: 50, graceMs: 10 }, finalOutput: () => '', pendingPermission: () => null,
  });
  svc.start(3999);
});
afterEach(() => { svc.stop(); fake.killAll(); fs.rmSync(root, { recursive: true, force: true }); });

const pdf = () => ({ name: 'Q3 report (final).pdf', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 test').toString('base64') });
const userMedia = () => { for (let i = svc.store.count() - 1; i >= 0; i--) { const m = svc.store.get(i)!; if (m.kind === 'user') return m.media; } return []; };

describe('send with files (2026-10-28: PDFs on a phone)', () => {
  it('saves a PDF to the media folder under a safe name and logs its path with the message', async () => {
    svc.send({ text: 'read this', project: null, images: [], files: [pdf()] });
    await settle(); // the turn logs the message after it renders the view
    const media = userMedia();
    expect(media).toHaveLength(1);
    expect(path.basename(media[0])).toMatch(/^\d+-0-[0-9a-f]{8}-Q3_report_final_.pdf$/);
    expect(fs.readFileSync(media[0], 'utf8')).toBe('%PDF-1.4 test');
    expect(svc.mediaFile(path.basename(media[0]))).toBe(media[0]);
  });

  it('a file alone is a message; files come after images in the media list', async () => {
    const png = { media_type: 'image/png', data: Buffer.from('png').toString('base64') };
    svc.send({ text: '', project: null, images: [png], files: [pdf()] });
    await settle();
    const media = userMedia();
    expect(media.map((f) => path.extname(f))).toEqual(['.png', '.pdf']);
  });

  it('refuses a type Chat does not take, and an empty file', () => {
    expect(() => svc.send({ text: 'x', project: null, images: [], files: [{ name: 'a.zip', media_type: 'application/zip', data: 'AAAA' }] })).toThrow(/unsupported file type/);
    expect(() => svc.send({ text: 'x', project: null, images: [], files: [{ name: 'a.pdf', media_type: 'application/pdf', data: '' }] })).toThrow(/between 1 byte and 20 MB/);
    expect(() => svc.send({ text: '', project: null, images: [], files: [] })).toThrow(/text or an attachment/);
  });
});

describe('safeFileName', () => {
  it('keeps letters, digits, dots, dashes and underscores; replaces the rest; forces the extension', () => {
    expect(safeFileName('Q3 report (final).PDF', 'pdf')).toBe('Q3_report_final_.pdf');
    expect(safeFileName('../../etc/passwd', 'txt')).toBe('passwd.txt');
    expect(safeFileName('', 'pdf')).toBe('file.pdf');
    expect(safeFileName('.hidden', 'md')).toBe('hidden.md');
  });
});
