// packages/core/src/sessions/spawn-error-text.test.ts
// SEC sweep: a failed thread start tells the client why in plain words, with no folder or command line.
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { SessionService } from './service.js';
import { PTYManager } from '../pty/manager.js';

function setup(failWith: Error) {
  const db = new Database(':memory:');
  initSchema(db);
  const pty = new PTYManager();
  pty.spawn = () => { throw failWith; };
  const svc = new SessionService(db, pty, '/tmp/mcp.json');
  const session = svc.create({ name: 'p', workingDir: '/tmp' } as any);
  return { svc, session };
}

describe('a failed thread start', () => {
  test('a system error (spawn ENOENT) is a plain sentence', () => {
    const err: any = new Error('spawn /Users/someone/.dispatch/tools/bin/claude ENOENT');
    err.code = 'ENOENT'; err.syscall = 'spawn /Users/someone/.dispatch/tools/bin/claude'; err.path = '/Users/someone/.dispatch/tools/bin/claude';
    const { svc, session } = setup(err);
    expect(() => svc.createTerminal(session.id, 'shell', 'sh')).toThrow(/^Failed to start sh: File or folder not found$/);
  });

  test('our own plain message is kept', () => {
    const { svc, session } = setup(new Error('posix_spawnp failed.'));
    expect(() => svc.createTerminal(session.id, 'shell', 'sh')).toThrow('Failed to start sh: posix_spawnp failed.');
  });
});
