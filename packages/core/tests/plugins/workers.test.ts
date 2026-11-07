import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginWorkers, LOG_MAX_BYTES, QUEUE_MAX_BYTES, socketPathFor, SOCKET_PATH_MAX } from '../../src/plugins/workers.js';
import { ThreadEvents } from '../../src/plugins/thread-events.js';
import { KeyRegistry } from '../../src/auth/principals.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(20); } }

/** Plugin workers (docs/superpowers/specs/2026-11-07-plugins-design.md, section 4; plugins slice 5). */
describe('PluginWorkers', () => {
  let tmp: string; let dir: string; let logDir: string; let runDir: string; let keys: KeyRegistry; let reg: PluginRegistry; let te: ThreadEvents; let w: PluginWorkers | null;
  const outFile = (id: string) => path.join(tmp, `${id}.out`);
  // A worker that notes its env, echoes every stdin line to a file, and can crash, ignore stdin, or serve a socket.
  const SCRIPT = `
    const fs = require('fs'); const out = process.env.OUT; const mode = process.argv[2] || '';
    fs.appendFileSync(out, JSON.stringify({ start: true, plugin: process.env.DISPATCH_PLUGIN, hasKeyFile: !!process.env.DISPATCH_PLUGIN_AUTH_FILE, api: process.env.DISPATCH_API, socket: process.env.DISPATCH_PLUGIN_SOCKET, auth: process.env.DISPATCH_AUTH ?? null }) + '\\n');
    if (mode === '--crash') process.exit(1);
    console.log('hello from ' + process.env.DISPATCH_PLUGIN); console.error('warn line');
    if (mode !== '--ignore-stdin') { let buf = ''; process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\\n')) >= 0) { fs.appendFileSync(out, buf.slice(0, i) + '\\n'); buf = buf.slice(i + 1); } }); }
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => process.exit(0));
  `;
  const plugin = (id: string, permissions: string[], worker: Record<string, unknown>) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'worker.js'), SCRIPT);
    fs.writeFileSync(path.join(dir, id, 'plugin.json'), JSON.stringify({ id, name: id, version: '1', permissions, worker: { command: process.execPath, args: ['worker.js'], env: { OUT: outFile(id) }, ...worker } }));
  };
  const lines = (id: string) => (fs.existsSync(outFile(id)) ? fs.readFileSync(outFile(id), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const events = (id: string) => lines(id).filter((l) => !l.start);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-workers-'));
    dir = path.join(tmp, 'plugins'); logDir = path.join(tmp, 'logs'); runDir = path.join(tmp, 'run');
    keys = new KeyRegistry(); w = null;
    te = new ThreadEvents({ broadcast: () => {} }, (id) => (id === 't1' ? { sessionId: 's1', harness: 'claude-code' } : null));
  });
  afterEach(async () => { await w?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const start = (opts: { backoffMs?: (n: number) => number; maxCrashes?: number; healthyMs?: number } = {}) => {
    reg = new PluginRegistry(dir, { broadcast: () => {} }, '3.28.0', { keys, keyDir: path.join(tmp, 'keys') });
    reg.issueKeys();
    w = new PluginWorkers(reg, te, { logDir, runDir, api: 'http://127.0.0.1:1', backoffMs: () => 10, maxCrashes: 3, healthyMs: 60_000, ...opts });
    reg.setWorkerStatsProvider((id) => w!.stats(id));
    w.sync();
    return w;
  };

  it('an enabled plugin with a worker starts it with the plugin env and its key file; disable stops it and the row says stopped', async () => {
    plugin('w1', [], {});
    const ww = start();
    await until(() => ww.stats('w1')?.state === 'running' && lines('w1').length > 0);
    const st = ww.stats('w1')!;
    expect(st.pid).toBeGreaterThan(0);
    expect(lines('w1')[0]).toMatchObject({ plugin: 'w1', hasKeyFile: true, api: 'http://127.0.0.1:1', auth: null });
    expect(lines('w1')[0].socket).toBe(path.join(runDir, 'plugin-w1.sock'));
    expect(reg.get('w1')!.workerStats).toMatchObject({ state: 'running', restarts: 0 });
    const pid = st.pid!;
    reg.setEnabled('w1', false); ww.sync();
    await until(() => ww.stats('w1')?.state === 'stopped');
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    expect(ww.stats('w1')).toMatchObject({ state: 'stopped', pid: null });
  });

  it('stdout and stderr land in the log file; logTail returns the last lines; a file over the cap rotates to .1', async () => {
    plugin('w2', [], {});
    fs.mkdirSync(path.join(logDir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(logDir, 'plugins', 'w2.log'), 'old\n'.repeat(4));
    fs.truncateSync(path.join(logDir, 'plugins', 'w2.log'), LOG_MAX_BYTES + 1);
    const ww = start();
    await until(() => { const t = ww.logTail('w2', 10); return t.includes('hello from w2') && t.includes('warn line'); });
    expect(fs.existsSync(path.join(logDir, 'plugins', 'w2.log.1'))).toBe(true);
    expect(fs.statSync(path.join(logDir, 'plugins', 'w2.log')).size).toBeLessThan(1000);
    expect(ww.logTail('w2', 1).trim()).toMatch(/hello from w2|warn line/);
  });

  it('a crash loop backs off and stops after the cap; restart() starts again and resets the count', async () => {
    plugin('w3', [], { args: ['worker.js', '--crash'] });
    const ww = start({ maxCrashes: 3 });
    await until(() => ww.stats('w3')?.state === 'crashed');
    expect(ww.stats('w3')).toMatchObject({ state: 'crashed', pid: null, restarts: 2 });
    expect(ww.stats('w3')!.lastExit).toMatchObject({ code: 1 });
    expect(lines('w3').filter((l) => l.start)).toHaveLength(3); // three crashes in a row is the cap: the first run and two retries
    // The author fixes the worker and presses Restart.
    fs.writeFileSync(path.join(dir, 'w3', 'plugin.json'), JSON.stringify({ id: 'w3', name: 'w3', version: '1', worker: { command: process.execPath, args: ['worker.js'], env: { OUT: outFile('w3') } } }));
    ww.restart('w3');
    await until(() => ww.stats('w3')?.state === 'running');
    expect(ww.stats('w3')!.restarts).toBe(0);
  });

  it('the feed is redacted like hooks, and carries the plugin\'s own plugin:data only', async () => {
    plugin('quiet', [], {});
    plugin('loud', ['read:prompts'], {});
    const ww = start();
    await until(() => ww.stats('quiet')?.state === 'running' && ww.stats('loud')?.state === 'running' && lines('quiet').length > 0 && lines('loud').length > 0);
    te.onPrompt('t1', 'Fix the login bug', 'user');
    reg.broadcast({ type: 'plugin:data', id: 'quiet', key: 'k' });
    reg.broadcast({ type: 'plugin:data', id: 'loud', key: 'other' });
    await until(() => events('quiet').length >= 2 && events('loud').length >= 2);
    expect(events('quiet')[0]).toMatchObject({ type: 'thread:prompt', terminalId: 't1', textLength: 17 });
    expect(events('quiet')[0].text).toBeUndefined();
    expect(events('loud')[0]).toMatchObject({ type: 'thread:prompt', text: 'Fix the login bug' });
    expect(events('quiet')[1]).toEqual({ type: 'plugin:data', id: 'quiet', key: 'k' });
    expect(events('loud')[1]).toEqual({ type: 'plugin:data', id: 'loud', key: 'other' });
  });

  it('an unread stdin never blocks the daemon, and the queue caps at 500', async () => {
    plugin('deaf', ['read:prompts'], { args: ['worker.js', '--ignore-stdin'] });
    const ww = start();
    await until(() => ww.stats('deaf')?.state === 'running');
    const t0 = Date.now();
    const big = 'x'.repeat(20_000);
    for (let i = 0; i < 2000; i++) te.onPrompt('t1', `${big} ${i}`, 'user');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ww.stats('deaf')!.queued).toBeLessThanOrEqual(500);
    expect(ww.stats('deaf')!.state).toBe('running');
  });

  it('a command that is not on PATH shows crashed with the error in the log; disable and enable work after it', async () => {
    plugin('ghost', [], { command: 'definitely-not-a-command-xyz' });
    const ww = start({ maxCrashes: 2 });
    await until(() => ww.stats('ghost')?.state === 'crashed');
    expect(ww.stats('ghost')).toMatchObject({ pid: null, state: 'crashed' });
    expect(ww.logTail('ghost', 20)).toMatch(/ENOENT|cannot start/);
    reg.setEnabled('ghost', false); ww.sync();
    await until(() => ww.stats('ghost')?.state === 'stopped');
    fs.writeFileSync(path.join(dir, 'ghost', 'plugin.json'), JSON.stringify({ id: 'ghost', name: 'ghost', version: '1', worker: { command: process.execPath, args: ['worker.js'], env: { OUT: outFile('ghost') } } }));
    reg.setEnabled('ghost', true); ww.sync();
    await until(() => ww.stats('ghost')?.state === 'running');
  });

  it('enable right after disable ends with the worker running', async () => {
    plugin('flip', [], {});
    const ww = start();
    await until(() => ww.stats('flip')?.state === 'running');
    reg.setEnabled('flip', false); ww.sync();
    reg.setEnabled('flip', true); ww.sync();
    await until(() => ww.stats('flip')?.state === 'running' && !ww.stats('flip')!.lastExit === false, 6000);
    await until(() => ww.stats('flip')?.state === 'running');
    expect(ww.stats('flip')!.lastExit).not.toBeNull();
  });

  it('the feed queue is capped in bytes as well as lines, and a single oversize line is dropped with a note', async () => {
    plugin('deaf2', ['read:prompts'], { args: ['worker.js', '--ignore-stdin'] });
    const ww = start();
    await until(() => ww.stats('deaf2')?.state === 'running');
    const big = 'x'.repeat(200_000);
    for (let i = 0; i < 100; i++) te.onPrompt('t1', `${big} ${i}`, 'user');
    expect(ww.stats('deaf2')!.queuedBytes).toBeLessThanOrEqual(QUEUE_MAX_BYTES);
    te.onPrompt('t1', 'y'.repeat(QUEUE_MAX_BYTES + 10), 'user');
    await until(() => ww.logTail('deaf2', 5).includes('dropped'));
  });

  it('the temp-folder fallback for the socket refuses a folder it does not own or that is open to others', () => {
    const longRun = path.join(os.tmpdir(), 'y'.repeat(120));
    const shared = path.join(fs.realpathSync(os.tmpdir()), 'dispatch-run');
    fs.rmSync(shared, { recursive: true, force: true });
    fs.mkdirSync(shared, { mode: 0o777 }); fs.chmodSync(shared, 0o777);
    const moved = socketPathFor(longRun, 'daily-rundown');
    expect(moved.startsWith(shared + path.sep)).toBe(false);
    expect((fs.statSync(path.dirname(moved)).mode & 0o777)).toBe(0o700);
    fs.rmSync(shared, { recursive: true, force: true });
  });

  it('a socket path that would be too long for a Unix socket moves to a short private folder under the temp dir', () => {
    const short = socketPathFor('/Users/me/.dispatch/run', 'daily-rundown');
    expect(short).toBe(path.join('/Users/me/.dispatch/run', 'plugin-daily-rundown.sock'));
    const longRun = path.join(os.tmpdir(), 'x'.repeat(120));
    const moved = socketPathFor(longRun, 'daily-rundown');
    expect(Buffer.byteLength(moved)).toBeLessThanOrEqual(SOCKET_PATH_MAX);
    expect(moved.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(moved).not.toBe(socketPathFor(longRun, 'other'));
    expect(moved).toBe(socketPathFor(longRun, 'daily-rundown'));
  });

  it('a job fires plugin:job on its cron minute, once per minute', async () => {
    plugin('jobby', [], { jobs: [{ id: 'm', cron: '* * * * *' }, { id: 'seven', cron: '0 7 * * *' }] });
    const ww = start();
    await until(() => ww.stats('jobby')?.state === 'running' && lines('jobby').length > 0);
    const at = new Date(2026, 10, 9, 7, 0);
    ww.tick(at); ww.tick(new Date(at.getTime() + 30_000));
    await until(() => events('jobby').length >= 2);
    expect(events('jobby').map((e) => [e.type, e.id]).sort()).toEqual([['plugin:job', 'm'], ['plugin:job', 'seven']]);
    ww.tick(new Date(at.getTime() + 60_000));
    await until(() => events('jobby').length >= 3);
    expect(events('jobby')[2]).toMatchObject({ type: 'plugin:job', id: 'm' });
    await sleep(100);
    expect(events('jobby')).toHaveLength(3);
  });
});
