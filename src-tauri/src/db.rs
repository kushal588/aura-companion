//! SQLite access layer (PLAN §9.2, §10.1).
//!
//! The renderer can only call *semantic* commands; raw SQL never crosses the IPC
//! boundary. Every statement here is parameterised, and rows are returned as the
//! same JSON shape the TypeScript entities use.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::error::AuraError;

/// Schema version shipped with this build. The TypeScript side mirrors it in
/// `src/storage/sqlDdl.ts` and the two are verified by the migration tests.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_init.sql")];

pub struct Database {
    connection: Connection,
}

impl Database {
    /// Open (creating if needed) the database inside the app data directory.
    pub fn open(path: PathBuf) -> Result<Self, AuraError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )?;
        let database = Self { connection };
        database.migrate()?;
        Ok(database)
    }

    pub fn migrate(&self) -> Result<(), AuraError> {
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL
            );",
        )?;
        for (index, sql) in MIGRATIONS.iter().enumerate() {
            let version = (index + 1) as i64;
            let applied: Option<i64> = self
                .connection
                .query_row(
                    "SELECT version FROM schema_migrations WHERE version = ?1",
                    params![version],
                    |row| row.get(0),
                )
                .optional()?;
            if applied.is_some() {
                continue;
            }
            let transaction = self.connection.unchecked_transaction()?;
            transaction.execute_batch(sql)?;
            transaction.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, datetime('now'))",
                params![version, format!("migration-{version}")],
            )?;
            transaction.commit()?;
        }
        Ok(())
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn purge(&self) -> Result<(), AuraError> {
        self.connection.execute_batch(
            "DELETE FROM messages;
             DELETE FROM conversations;
             DELETE FROM memories;
             DELETE FROM characters;
             DELETE FROM settings;",
        )?;
        Ok(())
    }
}

pub fn character_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "name": row.get::<_, String>("name")?,
        "manifestJson": row.get::<_, String>("manifest_json")?,
        "promptText": row.get::<_, String>("prompt_text")?,
        "promptVersion": row.get::<_, i64>("prompt_version")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
    }))
}

pub fn conversation_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "characterId": row.get::<_, String>("character_id")?,
        "parentConversationId": row.get::<_, Option<String>>("parent_conversation_id")?,
        "parentMessageId": row.get::<_, Option<String>>("parent_message_id")?,
        "title": row.get::<_, String>("title")?,
        "summary": row.get::<_, Option<String>>("summary")?,
        "ephemeral": row.get::<_, i64>("ephemeral")? == 1,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
    }))
}

pub fn message_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "conversationId": row.get::<_, String>("conversation_id")?,
        "role": row.get::<_, String>("role")?,
        "modality": row.get::<_, String>("modality")?,
        "bodyText": row.get::<_, String>("body_text")?,
        "status": row.get::<_, String>("status")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "modelId": row.get::<_, Option<String>>("model_id")?,
        "promptVersion": row.get::<_, Option<i64>>("prompt_version")?,
        "extraJson": row.get::<_, Option<String>>("extra_json")?,
    }))
}

pub fn memory_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "scope": row.get::<_, String>("scope")?,
        "characterId": row.get::<_, Option<String>>("character_id")?,
        "content": row.get::<_, String>("content")?,
        "category": row.get::<_, String>("category")?,
        "confidence": row.get::<_, f64>("confidence")?,
        "importance": row.get::<_, f64>("importance")?,
        "sourceMessageId": row.get::<_, Option<String>>("source_message_id")?,
        "status": row.get::<_, String>("status")?,
        "supersededBy": row.get::<_, Option<String>>("superseded_by")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
        "lastAccessedAt": row.get::<_, Option<String>>("last_accessed_at")?,
    }))
}

/// JSON helpers: the renderer sends camelCase, SQLite wants snake_case.
pub fn get_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn get_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

pub fn get_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

pub fn get_bool(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}
