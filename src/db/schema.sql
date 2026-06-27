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

CREATE TABLE IF NOT EXISTS episodes (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL,
  session       TEXT,
  actor         TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  content       TEXT NOT NULL,
  source        TEXT,
  metadata_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS semantic_memories (
  id                INTEGER PRIMARY KEY,
  project           TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'project',
  kind              TEXT NOT NULL DEFAULT 'fact',
  subject           TEXT NOT NULL,
  predicate         TEXT NOT NULL DEFAULT 'states',
  object            TEXT,
  content           TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 0.65,
  importance        REAL NOT NULL DEFAULT 0.5,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'superseded', 'invalidated')),
  valid_from        TEXT,
  valid_to          TEXT,
  last_confirmed_at TEXT,
  supersedes_id     INTEGER REFERENCES semantic_memories(id) ON DELETE SET NULL,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id  INTEGER NOT NULL REFERENCES semantic_memories(id) ON DELETE CASCADE,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  quote      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (memory_id, episode_id)
);

CREATE TABLE IF NOT EXISTS memory_conflicts (
  id                 INTEGER PRIMARY KEY,
  project            TEXT NOT NULL,
  memory_id          INTEGER NOT NULL REFERENCES semantic_memories(id) ON DELETE CASCADE,
  conflicting_id     INTEGER NOT NULL REFERENCES semantic_memories(id) ON DELETE CASCADE,
  reason             TEXT NOT NULL,
  resolution_status  TEXT NOT NULL DEFAULT 'open'
                     CHECK (resolution_status IN ('open', 'resolved', 'ignored')),
  resolved_memory_id INTEGER REFERENCES semantic_memories(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at        TEXT
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  id             INTEGER PRIMARY KEY,
  project        TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  alias          TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(project, alias)
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id    INTEGER PRIMARY KEY REFERENCES semantic_memories(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL DEFAULT 'local-hash',
  dimension    INTEGER NOT NULL,
  vector_json  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS episode_embeddings (
  episode_id   INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL DEFAULT 'local-hash',
  dimension    INTEGER NOT NULL,
  vector_json  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS memory_access_log (
  id            INTEGER PRIMARY KEY,
  project       TEXT NOT NULL,
  query         TEXT NOT NULL,
  intent        TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  latency_ms    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id         INTEGER PRIMARY KEY,
  project    TEXT NOT NULL,
  name       TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  report     TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_episodes_project_created ON episodes(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_project_session ON episodes(project, session);
CREATE INDEX IF NOT EXISTS idx_memories_project_status ON semantic_memories(project, status);
CREATE INDEX IF NOT EXISTS idx_memories_project_subject ON semantic_memories(project, subject);
CREATE INDEX IF NOT EXISTS idx_memories_project_kind ON semantic_memories(project, kind);
CREATE INDEX IF NOT EXISTS idx_memories_project_scope ON semantic_memories(project, scope);
CREATE INDEX IF NOT EXISTS idx_memory_sources_episode ON memory_sources(episode_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_project_status ON memory_conflicts(project, resolution_status);
CREATE INDEX IF NOT EXISTS idx_aliases_project_canonical ON entity_aliases(project, canonical_name);

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

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  project UNINDEXED,
  session UNINDEXED,
  actor,
  role,
  content,
  source,
  tokenize = 'porter'
);

CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memories_fts USING fts5(
  project UNINDEXED,
  scope UNINDEXED,
  kind,
  subject,
  predicate,
  object,
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
-- TRIGGERS: episodes -> episodes_fts
--------------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS episodes_ai
AFTER INSERT ON episodes
BEGIN
  INSERT INTO episodes_fts(rowid, project, session, actor, role, content, source)
  VALUES (
    new.id,
    new.project,
    COALESCE(new.session,''),
    COALESCE(new.actor,''),
    new.role,
    new.content,
    COALESCE(new.source,'')
  );
END;

CREATE TRIGGER IF NOT EXISTS episodes_ad
AFTER DELETE ON episodes
BEGIN
  DELETE FROM episodes_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS episodes_au
AFTER UPDATE OF project, session, actor, role, content, source ON episodes
BEGIN
  DELETE FROM episodes_fts WHERE rowid = new.id;
  INSERT INTO episodes_fts(rowid, project, session, actor, role, content, source)
  VALUES (
    new.id,
    new.project,
    COALESCE(new.session,''),
    COALESCE(new.actor,''),
    new.role,
    new.content,
    COALESCE(new.source,'')
  );
END;

--------------------------------------------------------------------------------
-- TRIGGERS: semantic_memories -> semantic_memories_fts
--------------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS semantic_memories_ai
AFTER INSERT ON semantic_memories
BEGIN
  INSERT INTO semantic_memories_fts(
    rowid,
    project,
    scope,
    kind,
    subject,
    predicate,
    object,
    content
  )
  VALUES (
    new.id,
    new.project,
    new.scope,
    new.kind,
    new.subject,
    new.predicate,
    COALESCE(new.object,''),
    new.content
  );
END;

CREATE TRIGGER IF NOT EXISTS semantic_memories_ad
AFTER DELETE ON semantic_memories
BEGIN
  DELETE FROM semantic_memories_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS semantic_memories_au
AFTER UPDATE OF project, scope, kind, subject, predicate, object, content ON semantic_memories
BEGIN
  DELETE FROM semantic_memories_fts WHERE rowid = new.id;
  INSERT INTO semantic_memories_fts(
    rowid,
    project,
    scope,
    kind,
    subject,
    predicate,
    object,
    content
  )
  VALUES (
    new.id,
    new.project,
    new.scope,
    new.kind,
    new.subject,
    new.predicate,
    COALESCE(new.object,''),
    new.content
  );
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
