-- 100 Days of Sweat — D1 schema
CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY,
  day_number INTEGER NOT NULL,
  activity TEXT,
  minutes INTEGER,
  intensity INTEGER,
  mood INTEGER,
  energy INTEGER,
  weight_kg REAL,
  resting_hr INTEGER,
  reel_done INTEGER DEFAULT 0,
  reel_url TEXT,
  notes TEXT,
  steps INTEGER,
  active_kcal INTEGER,
  health_workout_minutes INTEGER,
  health_workouts TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS posts (
  platform TEXT NOT NULL,
  post_id TEXT NOT NULL,
  url TEXT, caption TEXT, media_type TEXT,
  posted_at TEXT, posted_date TEXT,
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER, reach INTEGER,
  synced_at TEXT,
  PRIMARY KEY (platform, post_id)
);
CREATE TABLE IF NOT EXISTS follower_snapshots (
  platform TEXT NOT NULL, date TEXT NOT NULL,
  followers INTEGER, total_likes INTEGER, media_count INTEGER,
  PRIMARY KEY (platform, date)
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT,
  caption TEXT,
  is_public INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(date);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  platform TEXT PRIMARY KEY,
  access_token TEXT, refresh_token TEXT, user_id TEXT,
  expires_at INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY, platform TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT, ok INTEGER, message TEXT,
  at TEXT DEFAULT (datetime('now'))
);
-- Added later via migrations/0001 (kept here so a fresh database gets everything)
CREATE TABLE IF NOT EXISTS benchmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  test TEXT NOT NULL,
  value REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_benchmarks_test ON benchmarks(test, date);
CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_failures ON auth_failures(ip, at);
INSERT OR IGNORE INTO days (date, day_number, activity, notes)
VALUES ('2026-10-17', 1, 'Football', 'Day 1: football match with work colleagues');
