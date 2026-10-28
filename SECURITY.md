# Security policy

## Reporting a vulnerability

Please report privately rather than opening a public issue. Include:

- what the issue is and what an attacker gains;
- steps to reproduce, ideally a minimal case;
- affected files, version or commit;
- whether it needs a malicious avatar file, a malicious character prompt or only local access.

Expect an acknowledgement within a few days. Please give a reasonable window before public disclosure.

## Threat model

**In scope**

| Threat | Mitigation in this codebase |
|---|---|
| API key theft from the app | OS credential store; the renderer never receives the key in packaged builds; requests are signed in Rust (`src-tauri/src/gemini_credentials`/`gemini_gateway.rs`) |
| Key leaking into logs, errors, exports | `error.rs` redaction, `src/utils/redact.ts`, exports exclude anything key-like |
| Malicious character bundle (traversal, symlinks, zip bomb) | `src/utils/archive.ts` (+ tests) and validated copy-only import in Rust |
| Malicious VRM/GLB file | magic/version check, size caps, GPU limits, no script execution path |
| Prompt injection from user text, memory or imported persona | rules stated first and un-overridable, memories passed as untrusted claims, no LLM tool access, closed output allowlists |
| Model output driving the app | validated JSON segments only: enumerations, bounded lengths, no paths, no filenames |
| Renderer compromise via a remote origin | strict CSP, no remote content in the UI, asset protocol scoped to app data |
| Denial of service from a huge reply or endless audio | segment/turn limits, bounded TTS look-ahead, jitter-buffer caps, backpressure guard on mic chunks |

**Out of scope**

- Someone with full local access to your machine and your unlocked OS keychain.
- Anything Google does with data you choose to send to the Gemini API.
- Extracting an ephemeral Live token from your own running client: it is short-lived and Live-only by design.
- Unsigned development builds you compile yourself.

## Handling secrets

Never commit a key, token, keystore or certificate password. CI checks the tree for key-shaped strings. If you
accidentally commit a credential: rotate it immediately, then remove it from history — assume it is compromised.

## Supported versions

Pre-1.0: only the latest commit on the default branch is supported.
