# AURA

A **local-first 3D AI character companion**. Import your own VRM avatar, write your own personality, and talk by
text or voice using **your own Gemini API key**. Chats, memories, avatars and animation clips stay on your device.

Desktop (Tauri 2) and mobile (Android) shells are part of the design; the complete UI, conversation engine, memory
system and avatar renderer run as a normal web app too, which is what this repository's test suite verifies.

---

## What works today

| Area | Status |
|---|---|
| 3D avatar viewport (orbit camera, zoom, quality tiers, auto-downgrade on slow frames) | ✅ implemented |
| VRM avatar import + VRMA animation import with validation and GPU disposal | ✅ implemented (needs a `.vrm` you have the rights to) |
| Built-in procedural placeholder character (no third-party assets shipped) | ✅ implemented |
| Structured turn protocol: validated JSON segments, closed emotion/gesture allowlists | ✅ implemented + tested |
| Legacy `$emotion$` / `#voice#` authoring shorthand parser | ✅ implemented + tested |
| Text chat → Gemini → validated reply → expression/gesture/lip-sync playback | ✅ implemented (needs an API key) |
| Offline demo mode (no key, no network, no cost) | ✅ implemented |
| Gemini TTS speech with an audio-clock-driven mouth and gesture schedule | ✅ implemented |
| Live audio mode (state machine, mic pipeline, jitter buffer, interruption, reconnect) | ✅ implemented; the WebSocket protocol is written to the published API but **not yet verified against the live service** |
| SQLite persistence (characters, conversations, messages, memories, FTS5) via Tauri commands | ✅ implemented in Rust — **not compiled in this environment** (no Rust toolchain) |
| IndexedDB fallback store for browser/WebView development | ✅ implemented + tested |
| Durable memory: extraction, dedupe, contradiction supersession, scoped retrieval, edit/delete | ✅ implemented + tested |
| Conversation history: resume, rename, search, delete, branch, export/import | ✅ implemented + tested |
| Onboarding, settings, character editor, memory manager, history, diagnostics, a11y, phone layout | ✅ implemented |
| Windows `.exe`, Linux AppImage/`.deb`, Android `.apk`, signed installers | ⛔ **not built** — needs Rust, platform toolchains and signing keys |

### Not done yet (deliberately)

- **No packaged installers.** Tauri packaging requires the Rust toolchain and per-platform SDKs. The configuration
  (`src-tauri/`) is written and reviewed but has never been compiled here.
- **Live mode is unverified against Google.** The message shapes come from the official WebSocket guide
  (see `docs/ARCHITECTURE.md`); no test has run against the real service, because that needs a real key.
- **FBX animation retargeting, viseme alignment, scene editor, wardrobe, localisation** are post-v1 (PLAN §15 Phase 7).
- **No third-party avatars, voices or artwork.** Import files you have the rights to; see `docs/ASSET_LICENSES.md`.

---

## Requirements

- Node.js 20+ (for the web app, tests and CI)
- A Gemini API key from Google AI Studio for AI replies (optional — offline demo mode needs nothing)
- Optional, for packaged builds: Rust stable + the Tauri prerequisites for your platform (`docs/BUILD.md`)

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
```

Then either paste a Gemini API key in Settings, or tick **Offline demo mode** to explore the whole app with no key and
no cost. To try it with no key from the very first frame:

```bash
VITE_AURA_MOCK_PROVIDERS=1 npm run dev
```

## Commands

```bash
npm run dev         # Vite dev server
npm run build       # production web build
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # ESLint
npm test            # Vitest unit + integration suite
npm run icons       # regenerate the generated app icon
npm run tauri:dev   # desktop shell (needs Rust)
npm run tauri:build # installers (needs Rust + platform tooling)
```

## Deploying to Cloudflare Pages (free)

The repository is self-contained: a clean checkout builds with `npm ci && npm run build`, no secrets required (the key
is entered in-app at runtime, never baked into the bundle).

1. Push this repository to GitHub (`git push -u origin main`), or create a new public repo and push to it.
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick the repo.
3. Build settings (framework preset *Vite* fills these in automatically):
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Node.js version:** set env var `NODE_VERSION` = `20` if the default is older than 20.
4. Deploy. Every push to `main` redeploys automatically; PRs get preview URLs.

No environment variables are needed. Do **not** add a `*_API_KEY` to Pages settings — AURA is bring-your-own-key and
each user pastes their own Gemini key into Settings in the browser (stored in that browser's IndexedDB only).

Prefer the CLI instead of Git integration:

```bash
npm run build
npx wrangler pages deploy dist --project-name aura
```

## Models and cost

The defaults are the **Gemini 2.5 Flash** family, chosen to keep per-message cost low:

| Purpose | Default model ID |
|---|---|
| Text | `gemini-2.5-flash` |
| Speech (TTS) | `gemini-2.5-flash-preview-tts` |
| Live voice | `gemini-2.5-flash-native-audio-preview-12-2025` |

Every model ID is editable in Settings, with suggestions for newer models (`gemini-3.5-flash-lite`, `gemini-3.8-flash`,
`gemini-3.8-flash-lite-tts`, …). Model catalogues change and access to the 2.5 family is limited to accounts that have
used it before, so AURA never hardcodes a single permanent model: it validates the shape of a model ID, sends what you
configure, and reports provider errors in plain language. Requests are billed to **your** key — the app cannot estimate
your spend beyond the token counts in diagnostics.

## Privacy in one paragraph

Conversations, memories, avatars and animation clips are stored locally (SQLite on desktop, IndexedDB in the browser
fallback). AURA has no telemetry by default. When you send a message, that message, recent turns and the memories used
are sent to Google's Gemini API and are governed by Google's terms. Live mode also streams microphone audio while the
session is open; AURA never records or stores mic audio. Local storage is **not** the same as offline operation. Full
detail: `docs/PRIVACY.md`.

## How it is put together

```
src/
  app/          engine (services + render loop), zustand store, settings, credentials
  avatar/       stage, VRM asset manager, motion/expression/lip-sync controllers, event scheduler
  audio/        microphone capture, playback with audio clock, Live controller state machine
  conversation/ orchestrator, prompt builder, response validator, shorthand parser, emotion machine
  memory/       extraction, dedupe/supersession, retrieval ranking
  providers/    gemini (chat, TTS, Live, gateway) and deterministic mock providers
  storage/      Store interface: SQLite via Tauri, IndexedDB documents, in-memory for tests
  character/    character manifest + defaults
src-tauri/      Rust core: SQLite, OS credential store, scoped import, API gateway
tests/          unit + integration suite (98 tests)
```

Design rules that the tests enforce:

1. **Nothing reaches speech or the transcript with a control tag in it.** Malformed model output is repaired once, then
   replaced by plain neutral text.
2. **The user's turn is saved before the network call, and the reply is saved before speech synthesis.** A TTS failure
   can never lose a turn.
3. **The audio clock drives the face**, never wall-clock network timing; late events are skipped rather than jerking the
   avatar.
4. **A deleted memory is deleted.** Retrieval is scope-filtered, and removal is a hard delete.
5. **Temporary chats persist nothing** — not messages, not memories.

## Licence

MIT for the code (see `LICENSE`). **Assets are not covered**: this repository ships no third-party avatars, animations,
voices or artwork, and dependency attributions live in `NOTICE`. Importing a model does not change its licence.
