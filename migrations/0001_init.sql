-- ratebeer initial schema

CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nickname   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A "tasting" is a rating session. Exactly one may be active.
CREATE TABLE tastings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX tastings_one_active ON tastings (is_active) WHERE is_active = 1;

CREATE TABLE tasting_participants (
  tasting_id INTEGER NOT NULL REFERENCES tastings (id),
  user_id    INTEGER NOT NULL REFERENCES users (id),
  position   INTEGER NOT NULL DEFAULT 0,
  hidden_at  TEXT,
  PRIMARY KEY (tasting_id, user_id)
);

CREATE TABLE beers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tasting_id INTEGER NOT NULL REFERENCES tastings (id),
  name       TEXT NOT NULL,
  size_ml    INTEGER,
  abv        REAL,
  image_url  TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  hidden_at  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX beers_tasting ON beers (tasting_id, position);

-- A cleared rating is deleted.
CREATE TABLE ratings (
  beer_id    INTEGER NOT NULL REFERENCES beers (id),
  user_id    INTEGER NOT NULL REFERENCES users (id),
  tasting_id INTEGER NOT NULL REFERENCES tastings (id),
  score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
  comment    TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (beer_id, user_id)
);
CREATE INDEX ratings_tasting ON ratings (tasting_id);

-- beer_name / nickname are snapshots so the log survives renames and soft deletes.
-- actor_user_id is the real person who made the change (admin / impersonator); not shown in UI.
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tasting_id    INTEGER NOT NULL REFERENCES tastings (id),
  type          TEXT NOT NULL CHECK (type IN ('rated', 'changed', 'cleared', 'commented')),
  beer_id       INTEGER NOT NULL,
  beer_name     TEXT NOT NULL,
  user_id       INTEGER NOT NULL,
  nickname      TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  old_score     INTEGER,
  new_score     INTEGER,
  comment       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX events_tasting ON events (tasting_id, id DESC);

CREATE TABLE auth_sessions (
  token_hash          TEXT PRIMARY KEY,
  email               TEXT NOT NULL COLLATE NOCASE,
  expires_at          TEXT NOT NULL,
  impersonate_user_id INTEGER
);
CREATE INDEX auth_sessions_expires ON auth_sessions (expires_at);
