// Owner decision 2026-11-13: Codex shell for everyone; the box is the sandbox. On a hosted box a Codex
// thread runs without Codex's own (bubblewrap) sandbox, which cannot start there. A governed thread (a
// coordinator: read-only, how its write approvals are gated) keeps its sandbox. A local install is unchanged.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager, hostedSandbox } from '../../src/structured/codex-manager.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex-app-server.mjs');
const HOSTED = { OS_BASE_URL: 'https://os.example.com', OS_BOX_TOKEN: 'box-token-for-test' };

describe('hostedSandbox', () => {
  it('hosted: danger-full-access; DISPATCH_CODEX_SANDBOX=codex: none; a local install: none', () => {
    expect(hostedSandbox({ ...HOSTED })).toBe('danger-full-access');
    expect(hostedSandbox({ ...HOSTED, DISPATCH_CODEX_SANDBOX: 'codex' })).toBeUndefined();
    expect(hostedSandbox({ ...HOSTED, DISPATCH_CODEX_SANDBOX: ' CODEX ' })).toBeUndefined();
    expect(hostedSandbox({})).toBeUndefined();
  });
});

describe('the sandbox a Codex thread asks for at thread/start', () => {
  let logPath: string; const saved: Record<string, string | undefined> = {}; let m: CodexStructuredSessionManager | null = null;
  beforeEach(() => {
    for (const k of [...Object.keys(HOSTED), 'DISPATCH_CODEX_SANDBOX']) saved[k] = process.env[k];
    delete process.env.DISPATCH_CODEX_SANDBOX;
    logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sandbox-')), 'requests.jsonl');
  });
  afterEach(() => {
    m?.killAll(); m = null;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const startParams = async (hosted: boolean, opts: Record<string, unknown>) => {
    if (hosted) Object.assign(process.env, HOSTED); else for (const k of Object.keys(HOSTED)) delete process.env[k];
    m = new CodexStructuredSessionManager();
    m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_LOG: logPath }, ...opts });
    const t0 = Date.now();
    while (!fs.existsSync(logPath) || !fs.readFileSync(logPath, 'utf8').includes('thread/start')) {
      if (Date.now() - t0 > 5000) throw new Error('no thread/start');
      await new Promise((r) => setTimeout(r, 20));
    }
    return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.method === 'thread/start').params;
  };

  it('a smart thread on a hosted box: danger-full-access, on-request, the reviewer', async () => {
    expect(await startParams(true, { approvals: 'smart' })).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
  });
  it('a smart thread on a local install: workspace-write, as before', async () => {
    expect(await startParams(false, { approvals: 'smart' })).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  });
  it('a governed thread (a coordinator: read-only, on-request) keeps its sandbox on a hosted box', async () => {
    expect(await startParams(true, { approvalPolicy: 'on-request', sandbox: 'read-only' })).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' });
  });
});
