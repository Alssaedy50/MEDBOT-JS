-- MEDBOT-JS D1 bootstrap marker
-- Schema version: 17
-- Canonical executable schema: src/db/d1/migrations.js
--
-- This migration track is for a FRESH D1 database.
-- It must not be used as a destructive replacement for SQLite data.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO schema_meta(key, value)
VALUES ('schema_version', '17')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
