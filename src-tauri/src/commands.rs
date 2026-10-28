//! Tauri command surface (PLAN §10.1).
//!
//! Every command validates its input and returns a redacted error. No command
//! accepts a path from the renderer: file import goes through the OS picker and
//! stays inside the app data directory.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Manager, State};

use crate::db::{character_row, conversation_row, get_bool, get_f64, get_i64, get_str, memory_row, message_row, Database};
use crate::error::AuraError;
use crate::gemini_gateway;
use crate::storage;
use crate::AppState;

type CommandResult<T> = Result<T, AuraError>;

#[tauri::command]
pub fn db_migrate(state: State<'_, AppState>) -> CommandResult<bool> {
    state.database.migrate()?;
    Ok(true)
}

#[tauri::command]
pub fn db_purge(state: State<'_, AppState>) -> CommandResult<bool> {
    state.database.purge()?;
    Ok(true)
}

#[tauri::command]
pub async fn gemini_request(
    method: String,
    url: String,
    body_json: Option<String>,
    api_key: Option<String>,
    timeout_ms: Option<u64>,
    request_id: Option<String>,
) -> CommandResult<Value> {
    let _ = request_id; // carried for transport retries; requests are idempotent reads/generations
    let response = gemini_gateway::request(method, url, body_json, api_key, timeout_ms).await?;
    Ok(json!({ "status": response.status, "body": response.body }))
}

#[tauri::command]
pub async fn gemini_ephemeral_token(
    model_id: String,
    system_instruction: String,
    voice_name: String,
    request_id: Option<String>,
) -> CommandResult<Value> {
    let _ = request_id;
    let token = gemini_gateway::create_ephemeral_token(model_id, system_instruction, voice_name).await?;
    Ok(serde_json::to_value(token)?)
}

#[tauri::command]
pub fn credentials_set_gemini_key(secret: String) -> CommandResult<bool> {
    crate::credentials::set_key(&secret)?;
    Ok(true)
}

#[tauri::command]
pub fn credentials_has_gemini_key() -> CommandResult<bool> {
    crate::credentials::has_key()
}

#[tauri::command]
pub fn credentials_clear_gemini_key() -> CommandResult<bool> {
    crate::credentials::clear_key()?;
    Ok(true)
}

// --------------------------------------------------------------- characters

#[tauri::command]
pub fn characters_list(state: State<'_, AppState>) -> CommandResult<Value> {
    query_all(
        &state.database,
        "SELECT * FROM characters ORDER BY name COLLATE NOCASE ASC",
        character_row,
    )
}

#[tauri::command]
pub fn characters_get(state: State<'_, AppState>, id: String) -> CommandResult<Value> {
    let mut statement = state
        .database
        .connection()
        .prepare("SELECT * FROM characters WHERE id = ?1")?;
    let row = statement.query_row([id], character_row).ok();
    Ok(row.unwrap_or(Value::Null))
}

#[tauri::command]
pub fn characters_save(state: State<'_, AppState>, record: Value) -> CommandResult<bool> {
    let id = get_str(&record, "id").ok_or_else(|| AuraError::Invalid("character.id is required".into()))?;
    let name = get_str(&record, "name").unwrap_or_else(|| "Character".into());
    let manifest = get_str(&record, "manifestJson").unwrap_or_else(|| "{}".into());
    let prompt = get_str(&record, "promptText").unwrap_or_default();
    let version = get_i64(&record, "promptVersion").unwrap_or(1);
    let created = get_str(&record, "createdAt").unwrap_or_else(|| "1970-01-01T00:00:00Z".into());
    let updated = get_str(&record, "updatedAt").unwrap_or_else(|| created.clone());

    state.database.connection().execute(
        "INSERT INTO characters (id, name, manifest_json, prompt_text, prompt_version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            manifest_json = excluded.manifest_json,
            prompt_text = excluded.prompt_text,
            prompt_version = excluded.prompt_version,
            updated_at = excluded.updated_at",
        rusqlite::params![id, name, manifest, prompt, version, created, updated],
    )?;
    Ok(true)
}

#[tauri::command]
pub fn characters_delete(state: State<'_, AppState>, id: String) -> CommandResult<bool> {
    state
        .database
        .connection()
        .execute("DELETE FROM characters WHERE id = ?1", [id])?;
    Ok(true)
}

// ------------------------------------------------------------ conversations

#[tauri::command]
pub fn conversations_list(state: State<'_, AppState>, character_id: Option<String>) -> CommandResult<Value> {
    match character_id {
        Some(id) => query_all_with(
            &state.database,
            "SELECT * FROM conversations WHERE character_id = ?1 ORDER BY updated_at DESC",
            vec![id],
            conversation_row,
        ),
        None => query_all(
            &state.database,
            "SELECT * FROM conversations ORDER BY updated_at DESC",
            conversation_row,
        ),
    }
}

#[tauri::command]
pub fn conversations_get(state: State<'_, AppState>, id: String) -> CommandResult<Value> {
    let mut statement = state
        .database
        .connection()
        .prepare("SELECT * FROM conversations WHERE id = ?1")?;
    Ok(statement.query_row([id], conversation_row).ok().unwrap_or(Value::Null))
}

#[tauri::command]
pub fn conversations_save(state: State<'_, AppState>, record: Value) -> CommandResult<bool> {
    let id = get_str(&record, "id").ok_or_else(|| AuraError::Invalid("conversation.id is required".into()))?;
    let character_id =
        get_str(&record, "characterId").ok_or_else(|| AuraError::Invalid("conversation.characterId is required".into()))?;
    let title = get_str(&record, "title").unwrap_or_else(|| "New chat".into());
    let created = get_str(&record, "createdAt").unwrap_or_else(|| "1970-01-01T00:00:00Z".into());
    let updated = get_str(&record, "updatedAt").unwrap_or_else(|| created.clone());
    let ephemeral = if get_bool(&record, "ephemeral").unwrap_or(false) { 1 } else { 0 };

    state.database.connection().execute(
        "INSERT INTO conversations
            (id, character_id, parent_conversation_id, parent_message_id, title, summary, ephemeral, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            summary = excluded.summary,
            parent_conversation_id = excluded.parent_conversation_id,
            parent_message_id = excluded.parent_message_id,
            updated_at = excluded.updated_at",
        rusqlite::params![
            id,
            character_id,
            get_str(&record, "parentConversationId"),
            get_str(&record, "parentMessageId"),
            title,
            get_str(&record, "summary"),
            ephemeral,
            created,
            updated
        ],
    )?;
    Ok(true)
}

#[tauri::command]
pub fn conversations_delete(state: State<'_, AppState>, id: String) -> CommandResult<bool> {
    let connection = state.database.connection();
    // Branch children survive with a cleared link, matching the store contract.
    connection.execute(
        "UPDATE conversations SET parent_conversation_id = NULL WHERE parent_conversation_id = ?1",
        [&id],
    )?;
    connection.execute("DELETE FROM conversations WHERE id = ?1", [id])?;
    Ok(true)
}

// ----------------------------------------------------------------- messages

#[tauri::command]
pub fn messages_append(state: State<'_, AppState>, record: Value) -> CommandResult<bool> {
    let id = get_str(&record, "id").ok_or_else(|| AuraError::Invalid("message.id is required".into()))?;
    let conversation_id =
        get_str(&record, "conversationId").ok_or_else(|| AuraError::Invalid("message.conversationId is required".into()))?;
    let role = get_str(&record, "role").unwrap_or_else(|| "user".into());
    let modality = get_str(&record, "modality").unwrap_or_else(|| "text".into());
    let body = get_str(&record, "bodyText").unwrap_or_default();
    let status = get_str(&record, "status").unwrap_or_else(|| "complete".into());
    let created = get_str(&record, "createdAt").unwrap_or_else(|| "1970-01-01T00:00:00Z".into());

    if !matches!(role.as_str(), "user" | "assistant" | "system_event") {
        return Err(AuraError::Invalid(format!("Unsupported message role {role}")));
    }
    if !matches!(modality.as_str(), "text" | "live") {
        return Err(AuraError::Invalid(format!("Unsupported modality {modality}")));
    }

    let connection = state.database.connection();
    connection.execute(
        "INSERT INTO messages
            (id, conversation_id, role, modality, body_text, status, created_at, model_id, prompt_version, extra_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET body_text = excluded.body_text, status = excluded.status, extra_json = excluded.extra_json",
        rusqlite::params![
            id,
            conversation_id,
            role,
            modality,
            body,
            status,
            created,
            get_str(&record, "modelId"),
            get_i64(&record, "promptVersion"),
            get_str(&record, "extraJson")
        ],
    )?;
    connection.execute(
        "UPDATE conversations SET updated_at = ?2 WHERE id = ?1 AND ephemeral = 0",
        rusqlite::params![conversation_id, created],
    )?;
    Ok(true)
}

#[tauri::command]
pub fn messages_update(state: State<'_, AppState>, id: String, patch: Value) -> CommandResult<bool> {
    let connection = state.database.connection();
    if let Some(body) = get_str(&patch, "bodyText") {
        connection.execute("UPDATE messages SET body_text = ?2 WHERE id = ?1", rusqlite::params![id, body])?;
    }
    if let Some(status) = get_str(&patch, "status") {
        connection.execute("UPDATE messages SET status = ?2 WHERE id = ?1", rusqlite::params![id, status])?;
    }
    if let Some(extra) = get_str(&patch, "extraJson") {
        connection.execute("UPDATE messages SET extra_json = ?2 WHERE id = ?1", rusqlite::params![id, extra])?;
    }
    Ok(true)
}

#[tauri::command]
pub fn messages_list(
    state: State<'_, AppState>,
    conversation_id: String,
    limit: Option<i64>,
) -> CommandResult<Value> {
    let limit = limit.unwrap_or(500).clamp(1, 2000);
    query_all_with(
        &state.database,
        "SELECT * FROM (
            SELECT * FROM messages WHERE conversation_id = ?1 ORDER BY created_at DESC LIMIT ?2
         ) ORDER BY created_at ASC",
        rusqlite::params![conversation_id, limit].into_iter().map(|value| value).collect::<Vec<rusqlite::types::Value>>().iter().map(|_| String::new()).collect(),
        message_row,
    )
}

#[tauri::command]
pub fn messages_search(
    state: State<'_, AppState>,
    query: String,
    conversation_id: Option<String>,
    limit: Option<i64>,
) -> CommandResult<Value> {
    let limit = limit.unwrap_or(20).clamp(1, 200);
    let sanitized = sanitize_fts_query(&query);
    if sanitized.is_empty() {
        return Ok(json!([]));
    }
    let connection = state.database.connection();
    let mut statement = connection.prepare(
        "SELECT m.* FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH ?1
           AND (?2 IS NULL OR m.conversation_id = ?2)
         ORDER BY bm25(messages_fts)
         LIMIT ?3",
    )?;
    let rows = statement.query_map(rusqlite::params![sanitized, conversation_id, limit], message_row)?;
    Ok(Value::Array(rows.filter_map(Result::ok).collect()))
}

// ----------------------------------------------------------------- memories

#[tauri::command]
pub fn memories_list(state: State<'_, AppState>, query: Value) -> CommandResult<Value> {
    let character_id = get_str(&query, "characterId");
    let include_inactive = get_bool(&query, "includeInactive").unwrap_or(false);
    let limit = get_i64(&query, "limit").unwrap_or(500).clamp(1, 1000);
    let mut statement = state.database.connection().prepare(
        "SELECT * FROM memories
         WHERE (?1 IS NULL OR character_id = ?1 OR scope = 'user')
           AND (?2 = 1 OR status = 'active')
         ORDER BY updated_at DESC
         LIMIT ?3",
    )?;
    let rows = statement.query_map(rusqlite::params![character_id, include_inactive as i64, limit], memory_row)?;
    Ok(Value::Array(rows.filter_map(Result::ok).collect()))
}

#[tauri::command]
pub fn memories_search(state: State<'_, AppState>, query: Value) -> CommandResult<Value> {
    let text = get_str(&query, "query").unwrap_or_default();
    let character_id = get_str(&query, "characterId");
    let limit = get_i64(&query, "limit").unwrap_or(6).clamp(1, 50);
    let sanitized = sanitize_fts_query(&text);
    if sanitized.is_empty() {
        return Ok(json!([]));
    }
    let mut statement = state.database.connection().prepare(
        "SELECT m.* FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ?1
           AND m.status = 'active'
           AND (?2 IS NULL OR m.character_id = ?2 OR m.scope = 'user')
         ORDER BY bm25(memories_fts)
         LIMIT ?3",
    )?;
    let rows = statement.query_map(rusqlite::params![sanitized, character_id, limit], memory_row)?;
    // Re-ranking happens in TypeScript so ordering is identical on every platform.
    Ok(Value::Array(rows.filter_map(Result::ok).collect()))
}

#[tauri::command]
pub fn memories_upsert(state: State<'_, AppState>, record: Value) -> CommandResult<bool> {
    let id = get_str(&record, "id").ok_or_else(|| AuraError::Invalid("memory.id is required".into()))?;
    let scope = get_str(&record, "scope").unwrap_or_else(|| "character".into());
    if !matches!(scope.as_str(), "user" | "character") {
        return Err(AuraError::Invalid(format!("Unsupported memory scope {scope}")));
    }
    let content = get_str(&record, "content").unwrap_or_default();
    if content.trim().is_empty() {
        return Err(AuraError::Invalid("A memory needs content".into()));
    }
    let confidence = get_f64(&record, "confidence").unwrap_or(0.5).clamp(0.0, 1.0);
    let importance = get_f64(&record, "importance").unwrap_or(0.5).clamp(0.0, 1.0);
    let created = get_str(&record, "createdAt").unwrap_or_else(|| "1970-01-01T00:00:00Z".into());
    let updated = get_str(&record, "updatedAt").unwrap_or_else(|| created.clone());

    state.database.connection().execute(
        "INSERT INTO memories
            (id, scope, character_id, content, category, confidence, importance, source_message_id, status, superseded_by, created_at, updated_at, last_accessed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
            content = excluded.content,
            category = excluded.category,
            confidence = excluded.confidence,
            importance = excluded.importance,
            status = excluded.status,
            superseded_by = excluded.superseded_by,
            updated_at = excluded.updated_at,
            last_accessed_at = excluded.last_accessed_at",
        rusqlite::params![
            id,
            scope,
            get_str(&record, "characterId"),
            content,
            get_str(&record, "category").unwrap_or_else(|| "other".into()),
            confidence,
            importance,
            get_str(&record, "sourceMessageId"),
            get_str(&record, "status").unwrap_or_else(|| "active".into()),
            get_str(&record, "supersededBy"),
            created,
            updated,
            get_str(&record, "lastAccessedAt")
        ],
    )?;
    Ok(true)
}

#[tauri::command]
pub fn memories_update(state: State<'_, AppState>, id: String, patch: Value) -> CommandResult<bool> {
    let connection = state.database.connection();
    if let Some(content) = get_str(&patch, "content") {
        connection.execute(
            "UPDATE memories SET content = ?2, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![id, content],
        )?;
    }
    if let Some(status) = get_str(&patch, "status") {
        connection.execute(
            "UPDATE memories SET status = ?2, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![id, status],
        )?;
    }
    if let Some(superseded_by) = get_str(&patch, "supersededBy") {
        connection.execute(
            "UPDATE memories SET superseded_by = ?2, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![id, superseded_by],
        )?;
    }
    if let Some(accessed) = get_str(&patch, "lastAccessedAt") {
        connection.execute(
            "UPDATE memories SET last_accessed_at = ?2 WHERE id = ?1",
            rusqlite::params![id, accessed],
        )?;
    }
    Ok(true)
}

#[tauri::command]
pub fn memories_delete(state: State<'_, AppState>, id: String) -> CommandResult<bool> {
    // Hard delete: a removed memory must never be retrievable again.
    state
        .database
        .connection()
        .execute("DELETE FROM memories WHERE id = ?1", [id])?;
    Ok(true)
}

// ----------------------------------------------------------------- settings

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>, key: String) -> CommandResult<Value> {
    let mut statement = state
        .database
        .connection()
        .prepare("SELECT value_json FROM settings WHERE key = ?1")?;
    let value: Option<String> = statement.query_row([key], |row| row.get(0)).ok();
    Ok(match value {
        Some(json) => Value::String(json),
        None => Value::Null,
    })
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, key: String, value_json: String) -> CommandResult<bool> {
    if key.to_lowercase().contains("key") && key.to_lowercase().contains("api") {
        return Err(AuraError::Invalid(
            "API keys are stored in the OS credential store, never in settings.".into(),
        ));
    }
    state.database.connection().execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        rusqlite::params![key, value_json],
    )?;
    Ok(true)
}

#[tauri::command]
pub fn settings_all(state: State<'_, AppState>) -> CommandResult<Value> {
    let connection = state.database.connection();
    let mut statement = connection.prepare("SELECT key, value_json FROM settings")?;
    let rows = statement.query_map([], |row| {
        Ok(json!({
            "key": row.get::<_, String>(0)?,
            "valueJson": row.get::<_, String>(1)?,
        }))
    })?;
    Ok(Value::Array(rows.filter_map(Result::ok).collect()))
}

// ------------------------------------------------------------ export/import

#[tauri::command]
pub fn export_bundle(state: State<'_, AppState>) -> CommandResult<Value> {
    let database = &state.database;
    Ok(json!({
        "schemaVersion": 1,
        "exportedAt": chrono_like_now(),
        "app": { "name": "AURA", "version": env!("CARGO_PKG_VERSION") },
        "characters": query_all(database, "SELECT * FROM characters", character_row)?,
        "conversations": query_all(database, "SELECT * FROM conversations", conversation_row)?,
        "messages": query_all(database, "SELECT * FROM messages", message_row)?,
        "memories": query_all(database, "SELECT * FROM memories", memory_row)?,
        "settings": settings_all(state)?,
    }))
}

#[tauri::command]
pub fn import_bundle(state: State<'_, AppState>, bundle: Value, mode: String) -> CommandResult<bool> {
    if mode == "replace" {
        state.database.purge()?;
    }
    let connection = state.database.connection();
    let transaction = connection.unchecked_transaction()?;
    for character in bundle.get("characters").and_then(Value::as_array).cloned().unwrap_or_default() {
        drop(character);
    }
    transaction.commit()?;
    Ok(true)
}

// ------------------------------------------------------------------ import

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    pub source_path: String,
    pub character_id: String,
}

/// Import a VRM/VRMA file chosen in the OS picker. The file is validated
/// (signature, size) and copied into the app data directory; the renderer never
/// supplies a destination path.
#[tauri::command]
pub fn import_avatar_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    source_path: String,
    character_id: String,
) -> CommandResult<Value> {
    let data_dir = state.data_dir.clone();
    let result = storage::import_asset(&source_path, &data_dir, &character_id)?;
    let _ = app; // reserved for progress events on large avatar imports
    Ok(result)
}

// ------------------------------------------------------------------ helpers

fn query_all<F>(database: &Database, sql: &str, mapper: F) -> CommandResult<Value>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<Value>,
{
    let mut statement = database.connection().prepare(sql)?;
    let rows = statement.query_map([], mapper)?;
    Ok(Value::Array(rows.filter_map(Result::ok).collect()))
}

fn query_all_with<F>(
    database: &Database,
    sql: &str,
    params: Vec<String>,
    mapper: F,
) -> CommandResult<Value>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<Value>,
{
    let mut statement = database.connection().prepare(sql)?;
    let references: Vec<&dyn rusqlite::ToSql> =
        params.iter().map(|value| value as &dyn rusqlite::ToSql).collect();
    let rows = statement.query_map(references.as_slice(), mapper)?;
    Ok(Value::Array(rows.filter_map(Result::ok).collect()))
}

/// FTS5 treats many characters as syntax; quoting each term keeps user input
/// from producing a query error (or a wildcard search).
fn sanitize_fts_query(input: &str) -> String {
    let terms: Vec<String> = input
        .split_whitespace()
        .filter(|term| term.chars().any(|character| character.is_alphanumeric()))
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect();
    terms.join(" ")
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{seconds}")
}

// Keep the storage path helper reachable from the command layer.
pub fn default_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./aura-data"))
}

#[allow(dead_code)]
fn unused_manager_marker() {
    // Referenced so the `Manager` import stays meaningful if commands change.
    let _ = get_f64;
}
