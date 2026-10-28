/// <reference types="vite/client" />

/**
 * Build-time environment flags. Never place secrets here: anything under
 * `import.meta.env.VITE_*` is embedded in the shipped bundle.
 *
 * AURA is BYOK — the Gemini key is entered by the user at runtime and stored in
 * the OS credential store (desktop) or the app's local database (web fallback).
 */
interface ImportMetaEnv {
  /** Force the deterministic offline mock providers (no network, no key). */
  readonly VITE_AURA_MOCK_PROVIDERS?: string;
  /** Override the Gemini REST base URL (proxy/self-hosted gateway). */
  readonly VITE_AURA_GEMINI_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
