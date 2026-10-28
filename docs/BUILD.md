# Building AURA

## Web app and tests (no Rust needed)

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run dev        # http://localhost:3000
```

The web build is a complete, usable application: avatar stage, chat, memory, Live controller and the offline demo mode.
Desktop-only features (SQLite, OS keychain, native gateway) automatically fall back to their browser equivalents.

## Desktop installers (Windows / Linux)

Prerequisites, per the current Tauri v2 documentation:

- **Rust stable** (`rustup`) and the platform build tools
- **Windows**: Visual C++ build tools + WebView2 runtime (bundled on Windows 11)
- **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`

Then:

```bash
npm run icons            # regenerate src-tauri/icons/icon.png
npm run tauri icon src-tauri/icons/icon.png   # expand to .ico/.icns if you package
npm run tauri:build      # NSIS .exe on Windows, .deb + .AppImage on Linux
```

Artifacts land in `src-tauri/target/release/bundle/`. `tauri.conf.json` bundles `nsis`, `deb` and `appimage` by default.

## Android APK

Android packaging needs the Android SDK/NDK, Java 17+, the Rust Android targets, and a signing keystore for
distribution. Plugin and permission differences mean the desktop shell is not automatically a valid Android shell;
treat Android as a separate platform to validate on real hardware.

```bash
npm run tauri:android:init
npm run tauri:android:dev
npm run tauri:android:build     # signed APK with your keystore configured
```

## Releases

`.github/workflows/release.yml` builds Linux and Windows bundles and packs the source archives on a `v*` tag, then
attaches them to a GitHub release with `SHA256SUMS.txt`. Signing secrets are read from the repository's protected
environment and are never stored in the repository:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater artefact signing |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | Windows code signing (optional) |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_PASSWORD` | Android release signing |

Local builds do not need any of them.

## CI

`.github/workflows/ci.yml` runs formatting checks, ESLint, `tsc --noEmit`, the Vitest suite and the production web build
on every push and pull request. It also asserts the repository contains no key-like strings and that the Rust sources
are formatted, so an accidentally committed credential fails the build rather than shipping.

## Verification status in this repository

The web app, the test suite and the Rust sources are present here. The Rust core has **not** been compiled in the
environment this repository was generated in (no Rust toolchain available), so treat `cargo check`, `tauri:dev` and
`tauri:build` as the first things to run on your machine. `docs/ARCHITECTURE.md` lists which behaviours are covered by
the automated tests and which are exercised only by type checking.
