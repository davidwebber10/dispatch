CREATE TABLE IF NOT EXISTS pings (
  install_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  version    TEXT NOT NULL,
  platform   TEXT NOT NULL,
  providers  TEXT NOT NULL,
  threads    INTEGER NOT NULL,
  chat_turns INTEGER NOT NULL,
  projects   INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX IF NOT EXISTS idx_pings_day ON pings(day);
