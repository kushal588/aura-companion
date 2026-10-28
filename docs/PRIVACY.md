# Privacy disclosure

## Short version

- Chats, memories, character profiles, imported avatars and animation clips are stored **on your device**.
- There is **no AURA account and no AURA server**. AURA collects no telemetry by default.
- When you send a message or talk in Live mode, that content goes to **Google's Gemini API** under your own key and is
  governed by Google's terms and privacy policy.
- Local storage is **not** the same as working offline.

## What is stored locally

| Data | Where | Notes |
|---|---|---|
| Conversations and messages | SQLite (desktop) / IndexedDB (web fallback) | searchable, exportable, deletable |
| Memories | same database | with source message id, confidence and scope; editable and deletable |
| Character profiles and prompts | same database, prompt versions kept | |
| Imported avatars and animations | app data folder (`characters/<id>/…`) | validated copies, never executed |
| App settings | same database | model IDs, voice, quality, memory mode |
| API key | OS credential store (desktop) | not in settings, not in the database, not in a log |

Removing a memory is a hard delete: it is not retrieved again. **Delete all local data** in Settings purges characters,
conversations, messages, memories and settings.

## What leaves the device

| When | What is sent | To |
|---|---|---|
| You send a chat message | that message, recent turns, the memories used, the character prompt and the rules | Gemini API (`generativelanguage.googleapis.com`) |
| A reply is spoken | each reply segment's text, the voice name and the style hint | Gemini API |
| Live mode is running | microphone audio (16 kHz PCM chunks), and the persona/memory context when the session opens | Gemini API over WebSocket |
| You press *Test connection* | a tiny throwaway prompt | Gemini API |

Microphone audio is streamed only while a Live session is open. AURA does not record it, does not write it to disk and
does not keep a buffer after the session ends. Live transcripts are saved only when *Save Live transcripts* is on, and
partial transcripts are marked provisional rather than presented as verbatim quotes.

## What AURA does not do

- No third-party analytics, crash reporting or ad SDKs.
- No developer-owned API key inside installers, bundles or the repository.
- No camera, screen or file-system access beyond the avatar/animation files you pick.
- No training on your data, and no upload of your avatar files or database.
- No claim that optional diagnostics send anything anywhere: diagnostics are redacted and stay local.

## Diagnostics

If you enable diagnostics, AURA keeps a redacted record of model IDs, timings, parse issues and which memory ids were
used. Message text, memory text, microphone audio, credentials and absolute file paths are stripped before anything is
written to that panel (`src/utils/redact.ts`).

## Children and emotional safety

AURA is an AI character toy, not a companion substitute. Characters are labelled as fictional AI, prompts that
encourage dependency, jealousy or the replacement of real relationships are rejected by the app's rules, and the
character never claims to be human or physically present.

## Your responsibilities

You supply the Gemini API key, so you are the data controller for what you send. If you import a VRM avatar, a voice or
an animation made by someone else, check that its licence allows your use — AURA ships no third-party assets.
