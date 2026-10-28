//! Native Gemini gateway (PLAN §2.1, §8.6).
//!
//! Two jobs:
//!  1. perform REST requests so the long-lived API key never enters the renderer;
//!  2. mint short-lived ephemeral Live tokens, so Live mode can connect from the
//!     WebView with a credential that expires quickly and only works for Live.
//!
//! Endpoints are the documented ones:
//!  - REST:  POST/GET https://generativelanguage.googleapis.com/v1beta/{path}
//!  - Token: POST https://generativelanguage.googleapis.com/v1beta/auth_tokens

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::credentials;
use crate::error::{redact, AuraError};

const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Hosts the app is allowed to talk to. Anything else is refused, so a
/// compromised renderer cannot use the gateway as an open proxy.
const ALLOWED_HOSTS: &[&str] = &[
    "generativelanguage.googleapis.com",
    "localhost",
    "127.0.0.1",
];

#[derive(Debug, Serialize)]
pub struct GatewayResponse {
    pub status: u16,
    pub body: String,
}

fn client() -> Result<reqwest::Client, AuraError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| AuraError::Network(error.to_string()))
}

fn assert_allowed(url: &str) -> Result<(), AuraError> {
    let parsed = url::Url::parse(url).map_err(|error| AuraError::Invalid(error.to_string()))?;
    let host = parsed.host_str().unwrap_or_default();
    if !ALLOWED_HOSTS.contains(&host) {
        return Err(AuraError::Invalid(format!(
            "The gateway refuses to talk to {host}."
        )));
    }
    Ok(())
}

/// Perform a REST request. `api_key` is only used for the web fallback; when it
/// is `None` the stored credential is used.
pub async fn request(
    method: String,
    url: String,
    body_json: Option<String>,
    api_key: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<GatewayResponse, AuraError> {
    assert_allowed(&url)?;

    let key = match api_key {
        Some(value) => value,
        None => credentials::get_key()?.ok_or_else(|| {
            AuraError::Credential("No Gemini API key is stored on this device.".into())
        })?,
    };

    let client = client()?;
    let builder = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => return Err(AuraError::Invalid(format!("Unsupported method {other}"))),
    };
    let builder = builder.header("x-goog-api-key", key).header("content-type", "application/json");
    let builder = match &body_json {
        Some(body) => builder.body(body.clone()),
        None => builder,
    };
    let builder = match timeout_ms {
        Some(ms) => builder.timeout(Duration::from_millis(ms)),
        None => builder,
    };

    let response = builder
        .send()
        .await
        .map_err(|error| AuraError::Network(redact(&error.to_string())))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| AuraError::Network(redact(&error.to_string())))?;
    // Never echo a provider body that could contain the key back verbatim.
    Ok(GatewayResponse {
        status,
        body: redact(&body),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralTokenResponse {
    pub name: Option<String>,
    pub expire_time: Option<String>,
    pub new_session_expire_time: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralToken {
    pub token: String,
    pub expire_time: Option<String>,
    pub new_session_expire_time: Option<String>,
}

/// Mint an ephemeral Live token (default: 30 minutes, single use, one minute to
/// start a session). The constraints are locked to the audio-only Live config,
/// so the token cannot be reused for other models or modalities.
pub async fn create_ephemeral_token(
    model_id: String,
    system_instruction: String,
    voice_name: String,
) -> Result<EphemeralToken, AuraError> {
    let key = credentials::get_key()?.ok_or_else(|| {
        AuraError::Credential("Add your Gemini API key before starting Live mode.".into())
    })?;

    let now = time::OffsetDateTime::now_utc();
    let expire = (now + time::Duration::minutes(30)).format(&time::format_description::well_known::Rfc3339);
    let new_session = (now + time::Duration::minutes(1)).format(&time::format_description::well_known::Rfc3339);

    let payload = json!({
        "uses": 1,
        "expireTime": expire,
        "newSessionExpireTime": new_session,
        "liveConnectConstraints": {
            "model": format!("models/{}", model_id.trim_start_matches("models/")),
            "config": {
                "responseModalities": ["AUDIO"],
                "systemInstruction": { "parts": [{ "text": system_instruction }] },
                "speechConfig": {
                    "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice_name } }
                }
            }
        }
    });

    let response = client()?
        .post(format!("{API_BASE}/auth_tokens"))
        .header("x-goog-api-key", key)
        .header("content-type", "application/json")
        .body(payload.to_string())
        .send()
        .await
        .map_err(|error| AuraError::Network(redact(&error.to_string())))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(AuraError::Network(redact(&format!(
            "Token provisioning failed ({status}): {body}"
        ))));
    }

    let parsed: EphemeralTokenResponse = response
        .json()
        .await
        .map_err(|error| AuraError::Network(redact(&error.to_string())))?;

    let token = parsed
        .name
        .ok_or_else(|| AuraError::Network("The token service returned no token.".into()))?;

    Ok(EphemeralToken {
        token,
        expire_time: parsed.expire_time,
        new_session_expire_time: parsed.new_session_expire_time,
    })
}
