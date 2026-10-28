//! AURA native core (PLAN §2.1).
//!
//! Responsibilities: local SQLite database, OS credential storage, scoped file
//! import, and the API gateway that keeps the user's key out of the WebView.

mod commands;
mod credentials;
mod db;
mod error;
mod gemini_gateway;
mod storage;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    pub database: db::Database,
    pub data_dir: PathBuf,
    /// Live sessions are tracked so the app can tell the user how many are open.
    pub live_sessions: Mutex<Vec<String>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("./aura-data"));
            std::fs::create_dir_all(&data_dir)?;
            let database = db::Database::open(data_dir.join("aura.sqlite"))?;

            app.manage(AppState {
                database,
                data_dir,
                live_sessions: Mutex::new(Vec::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_migrate,
            commands::db_purge,
            commands::gemini_request,
            commands::gemini_ephemeral_token,
            commands::credentials_set_gemini_key,
            commands::credentials_has_gemini_key,
            commands::credentials_clear_gemini_key,
            commands::characters_list,
            commands::characters_get,
            commands::characters_save,
            commands::characters_delete,
            commands::conversations_list,
            commands::conversations_get,
            commands::conversations_save,
            commands::conversations_delete,
            commands::messages_append,
            commands::messages_update,
            commands::messages_list,
            commands::messages_search,
            commands::memories_list,
            commands::memories_search,
            commands::memories_upsert,
            commands::memories_update,
            commands::memories_delete,
            commands::settings_get,
            commands::settings_set,
            commands::settings_all,
            commands::export_bundle,
            commands::import_bundle,
            commands::import_avatar_file,
        ])
        .run(tauri::generate_context!())
        .expect("AURA failed to start");
}
