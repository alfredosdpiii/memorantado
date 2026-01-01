-- memorantado SQLite schema
-- Tables, indexes, FTS5 virtual tables, and triggers for sync

--------------------------------------------------------------------------------
-- CORE TABLES
--------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY,
  project     TEXT NOT NULL,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(project, name)
);

CREATE TABLE IF NOT EXISTS observations (
  id         INTEGER PRIMARY KEY,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(entity_id, content)
);

CREATE TABLE IF NOT EXISTS relations (
  id             INTEGER PRIMARY KEY,
  project        TEXT NOT NULL,
  from_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(project, from_entity_id, to_entity_id, relation_type)
);

CREATE TABLE IF NOT EXISTS memory_items (
  id         INTEGER PRIMARY KEY,
  project    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT,
  content    TEXT NOT NULL,
  tags_json  TEXT,
  source     TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

--------------------------------------------------------------------------------
-- INDEXES
--------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_entities_project_name ON entities(project, name);
CREATE INDEX IF NOT EXISTS idx_entities_project_type ON entities(project, entity_type);
CREATE INDEX IF NOT EXISTS idx_obs_entity_id ON observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_project_from ON relations(project, from_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_project_to ON relations(project, to_entity_id);
CREATE INDEX IF NOT EXISTS idx_items_project_created ON memory_items(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_project_kind ON memory_items(project, kind);

--------------------------------------------------------------------------------
-- FTS5 VIRTUAL TABLES
--------------------------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  project UNINDEXED,
  name,
  entity_type,
  tokenize = 'porter'
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  project UNINDEXED,
  entity_name,
  content,
  tokenize = 'porter'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
  project UNINDEXED,
  kind,
  title,
  content,
  tokenize = 'porter'
);

--------------------------------------------------------------------------------
-- TRIGGERS: entities -> entities_fts
--------------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS entities_ai
AFTER INSERT ON entities
BEGIN
  INSERT INTO entities_fts(rowid, project, name, entity_type)
  VALUES (new.id, new.project, new.name, new.entity_type);
END;

CREATE TRIGGER IF NOT EXISTS entities_ad
AFTER DELETE ON entities
BEGIN
  DELETE FROM entities_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS entities_au
AFTER UPDATE OF project, name, entity_type ON entities
BEGIN
  DELETE FROM entities_fts WHERE rowid = new.id;
  INSERT INTO entities_fts(rowid, project, name, entity_type)
  VALUES (new.id, new.project, new.name, new.entity_type);
END;

--------------------------------------------------------------------------------
-- TRIGGERS: observations -> observations_fts
--------------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS observations_ai
AFTER INSERT ON observations
BEGIN
  INSERT INTO observations_fts(rowid, project, entity_name, content)
  SELECT new.id, e.project, e.name, new.content
  FROM entities e
  WHERE e.id = new.entity_id;
END;

CREATE TRIGGER IF NOT EXISTS observations_ad
AFTER DELETE ON observations
BEGIN
  DELETE FROM observations_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS observations_au
AFTER UPDATE OF entity_id, content ON observations
BEGIN
  DELETE FROM observations_fts WHERE rowid = new.id;
  INSERT INTO observations_fts(rowid, project, entity_name, content)
  SELECT new.id, e.project, e.name, new.content
  FROM entities e
  WHERE e.id = new.entity_id;
END;

--------------------------------------------------------------------------------
-- TRIGGER: entity rename/project change -> rebuild observations_fts
--------------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS entities_rename_propagate_observations_fts
AFTER UPDATE OF name, project ON entities
BEGIN
  DELETE FROM observations_fts
  WHERE rowid IN (
    SELECT o.id FROM observations o WHERE o.entity_id = new.id
  );

  INSERT INTO observations_fts(rowid, project, entity_name, content)
  SELECT o.id, new.project, new.name, o.content
  FROM observations o
  WHERE o.entity_id = new.id;
END;

--------------------------------------------------------------------------------
-- TRIGGERS: memory_items -> memory_items_fts
--------------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS memory_items_ai
AFTER INSERT ON memory_items
BEGIN
  INSERT INTO memory_items_fts(rowid, project, kind, title, content)
  VALUES (new.id, new.project, new.kind, COALESCE(new.title,''), new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_items_ad
AFTER DELETE ON memory_items
BEGIN
  DELETE FROM memory_items_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memory_items_au
AFTER UPDATE OF project, kind, title, content ON memory_items
BEGIN
  DELETE FROM memory_items_fts WHERE rowid = new.id;
  INSERT INTO memory_items_fts(rowid, project, kind, title, content)
  VALUES (new.id, new.project, new.kind, COALESCE(new.title,''), new.content);
END;

--------------------------------------------------------------------------------
-- TRIGGERS: relation project consistency
--------------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS relations_bi_project_consistency
BEFORE INSERT ON relations
BEGIN
  SELECT
    CASE
      WHEN (SELECT project FROM entities WHERE id = new.from_entity_id) IS NULL THEN
        RAISE(ABORT, 'from_entity_id does not exist')
      WHEN (SELECT project FROM entities WHERE id = new.to_entity_id) IS NULL THEN
        RAISE(ABORT, 'to_entity_id does not exist')
      WHEN (SELECT project FROM entities WHERE id = new.from_entity_id) != new.project THEN
        RAISE(ABORT, 'from_entity_id project mismatch')
      WHEN (SELECT project FROM entities WHERE id = new.to_entity_id) != new.project THEN
        RAISE(ABORT, 'to_entity_id project mismatch')
    END;
END;

CREATE TRIGGER IF NOT EXISTS relations_bu_project_consistency
BEFORE UPDATE OF project, from_entity_id, to_entity_id ON relations
BEGIN
  SELECT
    CASE
      WHEN (SELECT project FROM entities WHERE id = new.from_entity_id) != new.project THEN
        RAISE(ABORT, 'from_entity_id project mismatch')
      WHEN (SELECT project FROM entities WHERE id = new.to_entity_id) != new.project THEN
        RAISE(ABORT, 'to_entity_id project mismatch')
    END;
END;
