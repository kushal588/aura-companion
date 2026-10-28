# Architecture

AURA is a Tauri 2 application: a React + TypeScript renderer, a Rust core, and a Three.js avatar stage. The renderer
never talks to the filesystem, the database or the OS credential store directly.

## Layers

```
React components ──▶ zustand store ──▶ AuraEngine ──▶ controllers / providers / store
                                             │
                                             └─▶ Tauri commands (SQLite, keychain, gateway, import)
```

**Single writer per channel.** The avatar has four animation channels and each has exactly one owner:

| Channel | Owner | Notes |
|---|---|---|
| Event timing | `AvatarScheduler` | drops stale session/turn events, applies on the audio clock |
| Bones / posture / gestures | `AvatarMotionController` | idle, breathing, gestures, VRMA clip crossfades |
| Face expressions / blink / gaze | `AvatarExpressionController` | mouth is written last so lip sync always wins |
| Mouth openness | `LipSyncController` | smoothed RMS with a noise gate; not phoneme alignment |

## Conversation path (text + voice replies)

```
user input
  → persist user message                     (never lost if the network fails)
  → memory retrieval (scope + lexical rank + budget)
  → prompt assembly (rules → persona → memory → history → input)
  → Gemini generateContent (responseSchema = turn schema)
  → validate (closed allowlists, bounded lengths, tag stripping)
      ├─ invalid → one repair attempt → plain neutral text fallback
  → persist assistant message                (before any TTS request)
  → estimate per-segment offsets → schedule emotion/expression/gesture events
  → Gemini TTS per segment (2-segment look-ahead, abortable)
  → playback scheduled on the AudioContext timeline; mouth follows the analyser
  → memory candidates evaluated after the turn is stored
```

## Live path (audio only, no camera)

```
mic (16 kHz PCM16, 32 ms chunks) → Gemini Live WebSocket → audio + transcripts
   → jitter buffer (hard cap, oldest dropped) → playback → mouth/gestures
   → transcripts persisted as `modality = 'live'` (partial ones marked provisional)
```

State machine: `idle → requesting_permission → connecting → ready → user_speaking → model_thinking → model_speaking
→ interrupted → listening`, with `reconnecting`/`error`/`disconnected` reachable from the right places. Every socket is
tagged with an epoch; audio from a previous epoch is ignored, so a reconnect cannot animate a dead session. An
`interrupted` event clears the queued audio immediately.

## Verified API facts (October 2026)

- Text: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, key in
  `x-goog-api-key`, `systemInstruction`, `generationConfig.responseMimeType: "application/json"` +
  `responseSchema`.
- Speech: `POST /v1beta/interactions` with `response_format: { type: "audio" }`, `generation_config.speech_config`
  and `annotations: [{ type: "speech_metadata", style }]`; audio base64 in `steps[].content[].data`. Unary requests
  return WAV (24 kHz mono), streaming returns headerless L16. A `generateContent` + `responseModalities: ["AUDIO"]`
  path is kept as a fallback for the 2.5 TTS models.
- Live: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=…`
  or `…BidiGenerateContentConstrained?access_token=…` for ephemeral tokens; first message is
  `{setup: {model, responseModalities, systemInstruction, speechConfig, inputAudioTranscription, outputAudioTranscription}}`;
  audio in is base64 PCM16 LE at 16 kHz; audio out arrives in `serverContent.modelTurn.parts[].inlineData`.
- Ephemeral tokens: `POST /v1beta/auth_tokens` with `uses`, `expireTime`, `newSessionExpireTime` and
  `liveConnectConstraints`. Defaults: 1 minute to start a session, 30 minutes to send messages.

Sources: `ai.google.dev/gemini-api/docs` (models, speech generation, structured output, Live WebSocket guide,
ephemeral tokens). Model IDs change; every one of them is configurable.

## Trust boundaries

- **Secrets.** Desktop: the key goes to the OS credential store via Rust and is used there. Web fallback: the key lives
  in memory for the session — never `localStorage`, never the database, never a bundle.
- **Files.** Import is a validated copy into the app data directory. Archive entries are inspected for absolute paths,
  traversal, symlinks, nested archives, oversized entries and zip-bomb ratios before anything is written.
- **Renderer input.** Tauri commands are semantic (`conversations_list`, `memories_search`, …). Raw SQL is never
  accepted from the renderer, and the asset protocol scope is limited to the app data folders.
- **Model output.** Treated as untrusted: closed enumerations, bounded lengths, no paths, no executable content, no
  tool access that could touch files or keys.

## Storage

SQLite (desktop) with FTS5 for message and memory search; the same entity shapes are implemented over IndexedDB for the
browser fallback, and an in-memory store backs the tests. Migrations live in `src-tauri/migrations/` and are mirrored —
and asserted — by `src/storage/sqlDdl.ts`.
