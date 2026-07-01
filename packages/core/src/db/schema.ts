import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      provider        TEXT NOT NULL,
      external_id     TEXT,
      name            TEXT NOT NULL,
      notes           TEXT DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'waiting',
      working_dir     TEXT NOT NULL,
      tags            TEXT DEFAULT '[]',
      pid             INTEGER,
      error           TEXT,
      skip_permissions INTEGER DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      archived_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS terminals (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      type            TEXT NOT NULL,
      label           TEXT NOT NULL,
      pid             INTEGER,
      external_id     TEXT,
      skip_permissions INTEGER DEFAULT 0,
      working_dir     TEXT,
      status          TEXT NOT NULL DEFAULT 'waiting',
      created_at      TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS agent_schedules (
      id                     TEXT PRIMARY KEY,
      project_id             TEXT NOT NULL,
      name                   TEXT NOT NULL,
      provider               TEXT NOT NULL,
      working_dir            TEXT NOT NULL,
      prompt                 TEXT NOT NULL,
      schedule_kind          TEXT NOT NULL,
      run_at                 TEXT,
      recurrence_rule        TEXT,
      timezone               TEXT NOT NULL,
      enabled                INTEGER NOT NULL DEFAULT 1,
      next_run_at            TEXT,
      default_terminal_label TEXT,
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id                  TEXT PRIMARY KEY,
      schedule_id         TEXT NOT NULL,
      project_id          TEXT NOT NULL,
      terminal_id         TEXT,
      provider            TEXT NOT NULL,
      prompt_snapshot     TEXT NOT NULL,
      status              TEXT NOT NULL,
      started_at          TEXT,
      completed_at        TEXT,
      error               TEXT,
      external_session_id TEXT,
      last_opened_at      TEXT,
      unread_since        TEXT,
      cost_usd            REAL,
      total_tokens        INTEGER,
      input_tokens        INTEGER,
      output_tokens       INTEGER,
      model               TEXT,
      num_turns           INTEGER,
      result_text         TEXT,
      transcript_path     TEXT,
      exit_code           INTEGER,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      FOREIGN KEY (schedule_id) REFERENCES agent_schedules(id),
      FOREIGN KEY (project_id) REFERENCES sessions(id),
      FOREIGN KEY (terminal_id) REFERENCES terminals(id)
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      command     TEXT,
      args        TEXT DEFAULT '[]',
      url         TEXT,
      headers     TEXT DEFAULT '{}',
      env         TEXT DEFAULT '{}',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      device_id   TEXT PRIMARY KEY,
      endpoint    TEXT NOT NULL,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    -- Durable "who sent this turn" tag, keyed by Claude Code's own per-line transcript
    -- uuid. The in-memory echo (structured/manager.ts) carries meta.source only for the
    -- life of the CLI process; once it exits, a re-hydrated chat rebuilds purely from the
    -- on-disk transcript, which has no such field. This table is the durable side-channel
    -- so a resolved uuid can be looked back up on any later disk read.
    CREATE TABLE IF NOT EXISTS message_source (
      terminal_id TEXT NOT NULL,
      uuid        TEXT NOT NULL,
      source      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (terminal_id, uuid)
    );
  `);

  // Migrations: add columns that may not exist on older databases
  const migrations = [
    { table: 'sessions', column: 'skip_permissions', sql: 'ALTER TABLE sessions ADD COLUMN skip_permissions INTEGER DEFAULT 0' },
    { table: 'sessions', column: 'external_id', sql: 'ALTER TABLE sessions ADD COLUMN external_id TEXT' },
    { table: 'sessions', column: 'error', sql: 'ALTER TABLE sessions ADD COLUMN error TEXT' },
    { table: 'sessions', column: 'last_activity_at', sql: 'ALTER TABLE sessions ADD COLUMN last_activity_at TEXT' },
    { table: 'terminals', column: 'working_dir', sql: 'ALTER TABLE terminals ADD COLUMN working_dir TEXT' },
    { table: 'terminals', column: 'status', sql: "ALTER TABLE terminals ADD COLUMN status TEXT NOT NULL DEFAULT 'waiting'" },
    { table: 'terminals', column: 'config', sql: "ALTER TABLE terminals ADD COLUMN config TEXT DEFAULT '{}'" },
    { table: 'terminals', column: 'archived_at', sql: 'ALTER TABLE terminals ADD COLUMN archived_at TEXT' },
    { table: 'terminals', column: 'sort_order', sql: 'ALTER TABLE terminals ADD COLUMN sort_order INTEGER DEFAULT 0' },
    { table: 'terminals', column: 'last_activity_at', sql: 'ALTER TABLE terminals ADD COLUMN last_activity_at TEXT' },
    { table: 'sessions', column: 'sort_order', sql: 'ALTER TABLE sessions ADD COLUMN sort_order INTEGER DEFAULT 0' },
    // Structured agent-run outcome capture (tokens, cost, model, result, transcript).
    { table: 'agent_runs', column: 'cost_usd', sql: 'ALTER TABLE agent_runs ADD COLUMN cost_usd REAL' },
    { table: 'agent_runs', column: 'total_tokens', sql: 'ALTER TABLE agent_runs ADD COLUMN total_tokens INTEGER' },
    { table: 'agent_runs', column: 'input_tokens', sql: 'ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER' },
    { table: 'agent_runs', column: 'output_tokens', sql: 'ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER' },
    { table: 'agent_runs', column: 'model', sql: 'ALTER TABLE agent_runs ADD COLUMN model TEXT' },
    { table: 'agent_runs', column: 'num_turns', sql: 'ALTER TABLE agent_runs ADD COLUMN num_turns INTEGER' },
    { table: 'agent_runs', column: 'result_text', sql: 'ALTER TABLE agent_runs ADD COLUMN result_text TEXT' },
    { table: 'agent_runs', column: 'transcript_path', sql: 'ALTER TABLE agent_runs ADD COLUMN transcript_path TEXT' },
    { table: 'agent_runs', column: 'exit_code', sql: 'ALTER TABLE agent_runs ADD COLUMN exit_code INTEGER' },
  ];

  for (const m of migrations) {
    try {
      const cols = db.pragma(`table_info(${m.table})`) as { name: string }[];
      if (!cols.find(c => c.name === m.column)) {
        db.exec(m.sql);
      }
    } catch {}
  }
}
