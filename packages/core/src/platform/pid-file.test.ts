import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeOwnPid, removeOwnPid } from './pid-file.js';

let dir: string;
const pidPath = () => path.join(dir, 'daemon.pid');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-file-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('daemon.pid', () => {
  it('records the given pid', () => {
    writeOwnPid(dir, 4242);
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe('4242');
  });

  it('removes the file on shutdown when it still holds our pid', () => {
    writeOwnPid(dir, 4242);
    removeOwnPid(dir, 4242);
    expect(fs.existsSync(pidPath())).toBe(false);
  });

  // A newer daemon may own the file by now: deleting it would leave WSL's restart() nothing to signal.
  it('leaves the file alone when another daemon wrote it', () => {
    writeOwnPid(dir, 5151);
    removeOwnPid(dir, 4242);
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe('5151');
  });

  it('a missing file is not an error', () => {
    expect(() => removeOwnPid(dir, 4242)).not.toThrow();
  });
});
