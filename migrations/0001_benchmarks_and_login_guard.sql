-- Benchmark tests (5k, push-ups, pull-ups, plank, burpees) and the login brute-force guard
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
