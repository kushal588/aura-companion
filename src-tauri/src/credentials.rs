//! API key storage in the operating system credential store (PLAN §12.2).
//!
//! The key is never written to the database, a file or a log. It is read only
//! inside `gemini_gateway` when signing a request, so it never reaches the
//! WebView in packaged builds.

use keyring::Entry;

use crate::error::AuraError;

const SERVICE: &str = "aura.gemini";
const ACCOUNT: &str = "default";

fn entry() -> Result<Entry, AuraError> {
    Entry::new(SERVICE, ACCOUNT).map_err(|error| AuraError::Credential(error.to_string()))
}

pub fn set_key(secret: &str) -> Result<(), AuraError> {
    let secret = secret.trim();
    if secret.len() < 8 {
        return Err(AuraError::Invalid(
            "That does not look like an API key (too short).".into(),
        ));
    }
    entry()?
        .set_password(secret)
        .map_err(|error| AuraError::Credential(error.to_string()))
}

pub fn get_key() -> Result<Option<String>, AuraError> {
    match entry()?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(AuraError::Credential(error.to_string())),
    }
}

pub fn has_key() -> Result<bool, AuraError> {
    Ok(get_key()?.is_some())
}

pub fn clear_key() -> Result<(), AuraError> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(AuraError::Credential(error.to_string())),
    }
}
