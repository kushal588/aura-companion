//! Native error type.
//!
//! Messages are written for humans and must never contain secrets: the gateway
//! redacts anything that looks like a key before an error reaches the renderer.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AuraError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("file system error: {0}")]
    Io(#[from] std::io::Error),
    #[error("network error: {0}")]
    Network(String),
    #[error("credential store error: {0}")]
    Credential(String),
    #[error("the request was rejected: {0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl Serialize for AuraError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&redact(&self.to_string()))
    }
}

/// Remove anything that looks like an API key, token or personal path.
pub fn redact(message: &str) -> String {
    let mut output = String::with_capacity(message.len());
    for token in message.split_whitespace() {
        if token.starts_with("AIza")
            || token.starts_with("AQ.")
            || token.len() > 40
            || token.starts_with("/home/")
            || token.starts_with("/Users/")
        {
            output.push_str("[redacted]");
        } else {
            output.push_str(token);
        }
        output.push(' ');
    }
    output.trim_end().to_string()
}
