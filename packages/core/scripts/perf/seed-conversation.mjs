// Seeds a fake HOME for the JSON compression check (plan section 1A.3): one archived Claude thread
// with a synthetic transcript, so GET /api/terminals/perf-thread/conversation answers 200 items and
// no agent process starts. Run it BEFORE the isolated daemon starts. Never run it on a real HOME.
// Run:  node packages/core/scripts/perf/seed-conversation.mjs <fake home>
import fs from 'node:fs';
import path from 'node:path';
import { writeSyntheticTranscript } from './synthetic-transcript.mjs';

const home = process.argv[2];
if (!home || !home.includes('w1-e-home')) { console.error('usage: seed-conversation.mjs <fake home that has w1-e-home in its path>'); process.exit(2); }
process.env.HOME = home;
const { createDatabase } = await import('../../dist/db/connection.js');

const workDir = '/tmp/w1e-perf';
const dir = path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));
fs.mkdirSync(dir, { recursive: true });
writeSyntheticTranscript(path.join(dir, 'perf-session.jsonl'), 2 * 1024 * 1024);

fs.mkdirSync(path.join(home, '.dispatch'), { recursive: true, mode: 0o700 });
const db = createDatabase(path.join(home, '.dispatch', 'dispatch.db'));
const now = new Date().toISOString();
db.prepare("INSERT OR IGNORE INTO sessions (id, provider, name, working_dir, status, created_at, updated_at, last_activity_at) VALUES ('perf-project','claude-code','perf',?, 'waiting', ?,?,?)").run(workDir, now, now, now);
db.prepare("INSERT OR IGNORE INTO terminals (id, session_id, type, label, external_id, working_dir, status, created_at, archived_at) VALUES ('perf-thread','perf-project','claude-code','perf','perf-session',?, 'waiting', ?, ?)").run(workDir, now, now);
db.close();
console.log('seeded perf-thread');
