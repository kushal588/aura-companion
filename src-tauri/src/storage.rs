//! Asset import (PLAN §5.1, §4.1, §14.1).
//!
//! Import is a copy-with-validation, never a move and never an extraction into a
//! user-chosen path. The renderer supplies only the OS-picker path; the
//! destination is always inside the app data directory and is derived from a
//! validated character id.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::error::AuraError;

/// 120 MB matches the renderer-side limit (`MAX_VRM_BYTES`).
const MAX_ASSET_BYTES: u64 = 120 * 1024 * 1024;
const ALLOWED_EXTENSIONS: &[&str] = &["vrm", "vrma", "glb"];

pub fn import_asset(source: &str, data_dir: &Path, character_id: &str) -> Result<Value, AuraError> {
    let source_path = PathBuf::from(source);
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AuraError::Invalid(format!(
            ".{extension} files are not imported. Use .vrm, .vrma or .glb."
        )));
    }

    let metadata = fs::metadata(&source_path)?;
    if metadata.len() > MAX_ASSET_BYTES {
        return Err(AuraError::Invalid(format!(
            "That file is {} MB. The limit is {} MB.",
            metadata.len() / 1_048_576,
            MAX_ASSET_BYTES / 1_048_576
        )));
    }

    // Verify the glTF container signature before copying anything.
    let mut file = fs::File::open(&source_path)?;
    let mut header = [0u8; 12];
    let read = file.read(&mut header)?;
    if read < 12 || &header[0..4] != b"glTF" {
        return Err(AuraError::Invalid(
            "That file is not a binary glTF/VRM container.".into(),
        ));
    }
    let version = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    if version != 2 {
        return Err(AuraError::Invalid(format!(
            "glTF version {version} is not supported (expected 2)."
        )));
    }

    let safe_character = sanitize_segment(character_id);
    if safe_character.is_empty() {
        return Err(AuraError::Invalid("character id is required".into()));
    }

    let target_dir = data_dir.join("characters").join(&safe_character);
    fs::create_dir_all(&target_dir)?;
    let file_name = sanitize_segment(
        source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("avatar.vrm"),
    );
    let target = target_dir.join(&file_name);

    // Destination is built from validated segments only, so it cannot escape.
    if !target.starts_with(&target_dir) {
        return Err(AuraError::Invalid("Refusing to write outside the app data directory".into()));
    }

    fs::copy(&source_path, &target)?;

    Ok(json!({
        "fileName": file_name,
        "relativePath": format!("characters/{safe_character}/{file_name}"),
        "bytes": fs::metadata(&target)?.len(),
        "extension": extension,
    }))
}

fn sanitize_segment(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric() || matches!(character, '-' | '_' | '.'))
        .take(120)
        .collect()
}
