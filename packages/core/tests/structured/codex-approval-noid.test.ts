// Final review N2: on a Codex thread, an answer with no request id is refused while another approval waits
// (the Codex manager now has hasWaitingPermission), so it can never land on a request the person did not see.
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';
import { ThreadQuestions } from '../../src/sessions/thread-questions.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-codex-three-approvals.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('an answer with no id is refused while requests wait; an answer that names its request goes through', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-noid-')), 'answers.ndjson');
  const m = new CodexStructuredSessionManager();
  try {
    m.spawn('t1', { command: process.execPath, args: [fake], workDir: process.cwd(), escalate: true, env: { ANSWER_LOG: log } });
    m.sendMessage('t1', 'go', 'user');
    for (let i = 0; i < 200 && !m.getPending('t1'); i++) await sleep(20);
    await sleep(300);
    expect(m.hasWaitingPermission('t1')).toBe(true);
    const svc = new ThreadQuestions({ threads: { structuredManagerForTerminal: () => m, restoredQuestions: () => undefined, logCoordinatorMessage: () => {}, noteQuestionAnsweredInChat: () => {} } } as never);
    const first = m.getPending('t1')!.requestId;
    expect(svc.answerPermission('t1', first, { decision: 'allow' })).toBe(true);
    await sleep(100);
    // Now the second request is in front and the third waits: an answer with no id must not land on it.
    expect(svc.answerPermission('t1', '', { decision: 'allow' })).toBe(false);
    const second = m.getPending('t1')!.requestId;
    expect(svc.answerPermission('t1', second, { decision: 'deny' })).toBe(true);
    await sleep(300);
    const answers = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(answers).toHaveLength(2);
  } finally {
    m.killAll();
  }
});
