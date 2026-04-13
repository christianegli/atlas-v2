-- Atlas v2 — SQLite Schema
-- Upgraded: 5-signal retrieval, fact graph edges, proactivity metrics,
--           evolution experiments, foresight dreams.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ─── Episodic Memory ──────────────────────────────────────────────────────────
-- Conversation summaries. Raw messages expire after 7 days; structure survives forever.
CREATE TABLE IF NOT EXISTS episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  summary     TEXT,                     -- Compressed summary (always kept)
  raw_messages TEXT,                    -- JSON array; cleared after 7 days
  entities    TEXT,                     -- JSON array of entity strings
  decisions   TEXT,                     -- JSON array of decisions made
  commitments TEXT,                     -- JSON array of action items
  topics      TEXT,                     -- JSON array of topic tags
  embedding   BLOB,                     -- Float32Array → Buffer
  token_count INTEGER DEFAULT 0,
  is_hot      INTEGER NOT NULL DEFAULT 1, -- 1=recent, 0=archived
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodes_created_at  ON episodes(created_at);
CREATE INDEX IF NOT EXISTS idx_episodes_is_hot      ON episodes(is_hot);
CREATE INDEX IF NOT EXISTS idx_episodes_access_count ON episodes(access_count);

-- ─── Semantic Memory ──────────────────────────────────────────────────────────
-- Durable facts about entities. Light graph via related_fact_ids.
CREATE TABLE IF NOT EXISTS facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  subject           TEXT NOT NULL,      -- Entity (person, project, concept)
  predicate         TEXT NOT NULL,      -- Relationship type
  object            TEXT NOT NULL,      -- Value
  confidence        REAL NOT NULL DEFAULT 1.0,
  source_episode_id INTEGER REFERENCES episodes(id),
  related_fact_ids  TEXT,               -- JSON array of fact IDs (light graph)
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  access_count      INTEGER DEFAULT 0,
  last_accessed     TEXT,
  embedding         BLOB
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_subject_predicate ON facts(subject, predicate);
CREATE INDEX IF NOT EXISTS idx_facts_subject    ON facts(subject);
CREATE INDEX IF NOT EXISTS idx_facts_updated_at ON facts(updated_at);

-- ─── Procedural Memory ────────────────────────────────────────────────────────
-- How to do things. Linked to preferences.md but queryable.
CREATE TABLE IF NOT EXISTS procedures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL,
  steps         TEXT NOT NULL,          -- JSON array
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  embedding     BLOB
);

-- ─── Interaction Metrics ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  session_id        TEXT NOT NULL,
  episode_id        INTEGER REFERENCES episodes(id),
  user_message      TEXT NOT NULL,
  assistant_response TEXT,
  tokens_input      INTEGER NOT NULL DEFAULT 0,
  tokens_output     INTEGER NOT NULL DEFAULT 0,
  tokens_total      INTEGER NOT NULL DEFAULT 0,
  corrections       INTEGER DEFAULT 0,
  retrieval_attempts INTEGER DEFAULT 0,
  retrieval_hits    INTEGER DEFAULT 0,
  retrieval_misses  INTEGER DEFAULT 0,
  dod_defined       INTEGER DEFAULT 0,  -- bool
  dod_met           INTEGER DEFAULT 0,  -- bool
  iterations_to_completion INTEGER,
  task_category     TEXT,
  proactive_surface INTEGER DEFAULT 0,  -- did agent surface context unprompted?
  user_score        INTEGER,            -- 1-5, null if not rated
  platform          TEXT NOT NULL DEFAULT 'telegram'
);

CREATE INDEX IF NOT EXISTS idx_interactions_session    ON interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_interactions_created_at ON interactions(created_at);

-- ─── Daily Aggregates ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_metrics (
  date                  TEXT PRIMARY KEY,  -- YYYY-MM-DD
  total_interactions    INTEGER DEFAULT 0,
  total_tokens          INTEGER DEFAULT 0,
  avg_tokens_per_task   REAL,
  total_corrections     INTEGER DEFAULT 0,
  correction_rate       REAL DEFAULT 0.0,
  retrieval_hit_rate    REAL,
  dod_completion_rate   REAL,
  avg_iterations        REAL,
  proactivity_rate      REAL,             -- proactive_surface / total_interactions
  user_score_avg        REAL,
  user_score_count      INTEGER DEFAULT 0,
  audit_status          TEXT,             -- JSON: crash count, old episodes, git conflicts
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Evolution Experiments ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS experiments (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  proposed_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  type                    TEXT NOT NULL,   -- 'targeted' | 'speculative' | 'meta-evolution'
  target_file             TEXT NOT NULL,
  hypothesis              TEXT NOT NULL,
  mutation                TEXT NOT NULL,   -- description or diff
  before_content          TEXT NOT NULL,
  after_content           TEXT,
  baseline_metrics        TEXT NOT NULL,   -- JSON snapshot
  result_metrics          TEXT,            -- JSON snapshot after eval
  synthetic_backtest_pass INTEGER,         -- 1=passed, 0=failed, null=not run
  evaluation_period_days  INTEGER DEFAULT 3,
  evaluation_start        TEXT,
  evaluation_end          TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'active'|'kept'|'reverted'|'proposed-only'
  outcome_reason          TEXT,
  effect_size             REAL,            -- abs(post - baseline) / baseline
  git_commit              TEXT
);

CREATE INDEX IF NOT EXISTS idx_experiments_status     ON experiments(status);
CREATE INDEX IF NOT EXISTS idx_experiments_proposed_at ON experiments(proposed_at);

-- ─── Pinned Contexts ──────────────────────────────────────────────────────────
-- Always included in retrieval regardless of query.
CREATE TABLE IF NOT EXISTS pinned_contexts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL UNIQUE,
  content     TEXT NOT NULL,
  priority    INTEGER DEFAULT 5,       -- 1-10
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,                    -- auto-unpin after this date
  created_by  TEXT NOT NULL DEFAULT 'user'
);

-- ─── External Feed Items ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feed_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  url              TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  content          TEXT,
  summary          TEXT,
  published_at     TEXT,
  feed_name        TEXT NOT NULL,
  category         TEXT NOT NULL,
  relevance_score  REAL,
  relevant_projects TEXT,              -- JSON array
  processed        INTEGER NOT NULL DEFAULT 0,
  surfaced         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feed_items_processed  ON feed_items(processed);
CREATE INDEX IF NOT EXISTS idx_feed_items_category   ON feed_items(category);

-- ─── Dreams ───────────────────────────────────────────────────────────────────
-- Subconscious output: connections, insights, foresight, narrative threads.
CREATE TABLE IF NOT EXISTS dreams (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  dream_type        TEXT NOT NULL,     -- 'replay'|'collision'|'external'|'interrogation'|'foresight'|'narrative_thread'
  content           TEXT NOT NULL,
  quality_score     REAL NOT NULL DEFAULT 0.5,  -- 0.0-1.0
  notified          INTEGER NOT NULL DEFAULT 0,
  source_ids        TEXT,              -- JSON array of episode/fact IDs
  embedding         BLOB,
  user_response     TEXT               -- null|'acknowledged'|'valuable'|'noise'
);

CREATE INDEX IF NOT EXISTS idx_dreams_created_at   ON dreams(created_at);
CREATE INDEX IF NOT EXISTS idx_dreams_dream_type   ON dreams(dream_type);
CREATE INDEX IF NOT EXISTS idx_dreams_quality_score ON dreams(quality_score);
CREATE INDEX IF NOT EXISTS idx_dreams_notified     ON dreams(notified);

-- ─── Onboarding State ─────────────────────────────────────────────────────────
-- Tracks which onboarding questions have been asked and answered.
CREATE TABLE IF NOT EXISTS onboarding (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL UNIQUE,   -- e.g. "name", "timezone", "active_projects"
  question    TEXT NOT NULL,
  answered    INTEGER NOT NULL DEFAULT 0,
  answer      TEXT,
  asked_at    TEXT,
  answered_at TEXT
);
