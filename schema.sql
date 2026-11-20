-- Optional: the API creates these tables automatically on first use.
-- Run this yourself only if you prefer to set the database up by hand:
--   wrangler d1 execute <your-db-name> --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS books (
  id         TEXT PRIMARY KEY,
  workKey    TEXT,
  title      TEXT NOT NULL,
  author     TEXT,
  year       INTEGER,
  pages      INTEGER,
  isbn       TEXT,
  coverId    TEXT,
  status     TEXT NOT NULL DEFAULT 'want',
  rating     INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  spineColor TEXT,
  accentColor TEXT,
  addedAt    INTEGER NOT NULL DEFAULT 0,
  updatedAt  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_books_added ON books (addedAt DESC);

CREATE TABLE IF NOT EXISTS auth_attempts (
  ip        TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0,
  lockUntil INTEGER NOT NULL DEFAULT 0
);

-- Upgrading a database made by the original app? Add the new column once:
-- ALTER TABLE books ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0;
-- (The API also does this automatically.)
