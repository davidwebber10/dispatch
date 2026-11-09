// Perf check for W1-E item 5 (plan section 1A.3, "Lifecycle trim and indexes").
// Times 5,000 logLifecycle calls on a temp database and prints the query plan of the four lookups.
// Run:  node packages/core/scripts/perf/lifecycle-and-indexes.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDatabase } from '../../dist/db/connection.js';
import { logLifecycle } from '../../dist/runtime/diagnostics.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1e-db-'));
const db = createDatabase(path.join(dir, 'dispatch.db'));
const now = new Date().toISOString();
db.prepare("INSERT INTO sessions (id, provider, name, working_dir, created_at, updated_at, last_activity_at) VALUES ('s1','claude-code','p','/tmp',?,?,?)").run(now, now, now);
const insT = db.prepare("INSERT INTO terminals (id, session_id, type, label, created_at) VALUES (?,?,?,?,?)");
for (let i = 0; i < 10; i++) insT.run(`t${i}`, 's1', 'claude-code', `t${i}`, now);

const N = 5000;
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  logLifecycle(db, { terminalId: `t${i % 10}`, type: 'status.working', observedAt: now }, 'applied');
}
const ms = performance.now() - t0;
const rows = db.prepare('SELECT terminal_id, COUNT(*) n FROM lifecycle_events GROUP BY terminal_id').all();

const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
console.log(JSON.stringify({
  events: N,
  totalMs: +ms.toFixed(1),
  perEventMicros: +((ms * 1000) / N).toFixed(1),
  maxRowsPerTerminal: Math.max(...rows.map((r) => r.n)),
  pragmas: { journal_mode: db.pragma('journal_mode', { simple: true }), synchronous: db.pragma('synchronous', { simple: true }), busy_timeout: db.pragma('busy_timeout', { simple: true }) },
  plans: {
    'terminals(session_id)': plan("SELECT * FROM terminals WHERE session_id = 's1'"),
    'terminals(status)': plan("SELECT * FROM terminals WHERE status = 'working'"),
    'agent_runs(terminal_id)': plan("SELECT * FROM agent_runs WHERE terminal_id = 't1'"),
    'agent_runs(schedule_id)': plan("SELECT * FROM agent_runs WHERE schedule_id = 'x'"),
  },
}, null, 2));
db.close();
fs.rmSync(dir, { recursive: true, force: true });
