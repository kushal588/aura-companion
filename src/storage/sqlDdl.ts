/**
 * SQLite schema and migrations (PLAN §9.2).
 *
 * These statements are shipped as-is to the Rust side, where they are executed
 * inside a transaction. The same file is the single source of truth for the
 * FTS5 search tables, the indexes and the foreign-key cascade rules, so the
 * migration order can be replayed and unit tested as text.
 *
 * API keys are deliberately absent: secrets live in the OS credential store.
 */

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        prompt_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        parent_conversation_id TEXT,
        parent_message_id TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system_event')),
        modality TEXT NOT NULL CHECK(modality IN ('text','live')),
        body_text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending','complete','error','interrupted')),
        created_at TEXT NOT NULL,
        model_id TEXT,
        prompt_version INTEGER,
        extra_json TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('user','character')),
        character_id TEXT,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
        importance REAL NOT NULL DEFAULT 0.5 CHECK(importance BETWEEN 0 AND 1),
        source_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active','disabled','superseded','deleted')),
        superseded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_character
        ON conversations(character_id, updated_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at ASC);`,
      `CREATE INDEX IF NOT EXISTS idx_memories_scope
        ON memories(status, scope, character_id);`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        body_text,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );`,
      `CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, body_text) VALUES (new.rowid, new.body_text);
      END;`,
      `CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, body_text)
          VALUES('delete', old.rowid, old.body_text);
      END;`,
      `CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, body_text)
          VALUES('delete', old.rowid, old.body_text);
        INSERT INTO messages_fts(rowid, body_text) VALUES (new.rowid, new.body_text);
      END;`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );`,
      `CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;`,
      `CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
      END;`,
      `CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content)
          VALUES('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

/** Pragmas applied once per connection. WAL keeps reads from blocking writes. */
export const CONNECTION_PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA busy_timeout = 5000;',
];

export function migrationSql(upTo = LATEST_SCHEMA_VERSION): string[] {
  const statements: string[] = [...CONNECTION_PRAGMAS];
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) break;
    statements.push(...migration.statements);
  }
  return statements;
}
