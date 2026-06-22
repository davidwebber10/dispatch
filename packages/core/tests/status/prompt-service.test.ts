import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { PromptService } from '../../src/status/prompt-service.js';

let db: Database.Database;
let broadcaster: { broadcast: ReturnType<typeof vi.fn> };
let buffers: Record<string, string>;
const ptyManager = { getBuffer: (id: string) => buffers[id] ?? '' } as any;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
  terminalsDb.create(db, { id: 'term', sessionId: 'proj', type: 'claude-code', label: 't', skipPermissions: true });
  broadcaster = { broadcast: vi.fn() };
  buffers = {};
});

const events = () => broadcaster.broadcast.mock.calls.map((c) => c[0]).filter((e: any) => e.type === 'terminal:prompt');

describe('PromptService', () => {
  it('broadcasts a detected prompt', async () => {
    buffers['term'] = 'Continue? (y/n)';
    await new PromptService(db, ptyManager, broadcaster).check('term');
    expect(events().at(-1)).toMatchObject({ terminalId: 'term', prompt: { kind: 'confirm' } });
  });

  it('does not re-broadcast an unchanged prompt', async () => {
    buffers['term'] = 'Continue? (y/n)';
    const s = new PromptService(db, ptyManager, broadcaster);
    await s.check('term'); await s.check('term');
    expect(events()).toHaveLength(1);
  });

  it('broadcasts null when the prompt clears (screen advanced)', async () => {
    buffers['term'] = 'Continue? (y/n)';
    const s = new PromptService(db, ptyManager, broadcaster);
    await s.check('term');
    buffers['term'] = 'thinking...\nassistant text now\n> ';
    await s.check('term');
    expect(events().at(-1)).toEqual({ type: 'terminal:prompt', terminalId: 'term', prompt: null });
  });

  it('clear() emits null only if a prompt was active', () => {
    const s = new PromptService(db, ptyManager, broadcaster);
    s.clear('term');
    expect(events()).toHaveLength(0);
  });

  it('ignores unknown terminals', async () => {
    await expect(new PromptService(db, ptyManager, broadcaster).check('nope')).resolves.toBeUndefined();
    expect(events()).toHaveLength(0);
  });
});
