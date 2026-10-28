import { ProviderError } from '../../types/model';
import { toProviderError } from '../../utils/retry';
import { GEMINI_API_BASE_URL } from './ModelCapabilities';

/**
 * Shared REST plumbing for the Gemini adapters (PLAN §2.3, §8.6).
 *
 * Two transports exist:
 *  - `fetch`  — used by the browser/WebView fallback.
 *  - `native` — the Tauri command `gemini_request`, which performs the request
 *               in Rust so the long-lived API key never enters the renderer.
 *
 * The renderer only ever holds the key while the user is typing it; the adapter
 * asks the native credential store for the request to be signed instead. In the
 * web fallback the key is held in memory for the session and stored locally
 * (never in `localStorage` under a guessable name — see `credentialStore.ts`).
 */

export interface GeminiRequestOptions {
  method?: 'GET' | 'POST';
  path: string;
  body?: unknown;
  signal: AbortSignal;
  /** Auth: either an inline key (web fallback) or the native credential store. */
  auth: GeminiAuth;
}

export type GeminiAuth =
  | { kind: 'inline'; apiKey: string }
  | { kind: 'native' }
  | { kind: 'ephemeral'; token: string };

export interface GeminiTransport {
  request<T>(options: GeminiRequestOptions): Promise<T>;
  readonly kind: 'fetch' | 'native';
}

export function resolveBaseUrl(): string {
  const override = import.meta.env?.VITE_AURA_GEMINI_BASE_URL;
  return override && override.length > 0 ? override.replace(/\/+$/, '') : GEMINI_API_BASE_URL;
}

export function buildUrl(path: string): string {
  const base = resolveBaseUrl();
  return path.startsWith('http') ? path : `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Resolve the credential header value. The native transport signs the request in
 * Rust, so no key is ever handed to the renderer in packaged builds.
 */
function keyFromAuth(auth: GeminiAuth): string | undefined {
  if (auth.kind === 'native') return undefined;
  const value = auth.kind === 'inline' ? auth.apiKey : auth.token;
  if (!value) {
    throw new ProviderError({
      kind: 'auth',
      retryable: false,
      message: 'No Gemini API key is configured. Add one in Settings.',
    });
  }
  return value;
}

/** Browser/WebView transport. */
export function createFetchTransport(): GeminiTransport {
  return {
    kind: 'fetch',
    async request<T>({ method = 'POST', path, body, signal, auth }: GeminiRequestOptions): Promise<T> {
      const key = keyFromAuth(auth);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (key) headers['x-goog-api-key'] = key;

      let response: Response;
      try {
        response = await fetch(buildUrl(path), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          throw new ProviderError({ kind: 'aborted', retryable: false, message: 'Request aborted' });
        }
        const message = error instanceof Error ? error.message : String(error);
        // A blocked browser fetch surfaces as an opaque TypeError. Live mode and
        // the desktop build avoid this by going through the native gateway.
        throw new ProviderError({
          kind: 'cors',
          retryable: false,
          message: `The request to the AI service was blocked (${message}). The desktop build routes these requests through the native gateway.`,
        });
      }

      if (!response.ok) {
        const text = await safeText(response);
        throw toProviderError(response.status, text);
      }
      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new ProviderError({
          kind: 'server',
          retryable: true,
          message: `The AI service returned an unreadable response (${String(error)}).`,
        });
      }
    },
  };
}

/**
 * Native transport. Requests are executed in Rust; the renderer passes the URL
 * and body but never the key (auth kind `native`).
 */
export function createNativeTransport(invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>): GeminiTransport {
  return {
    kind: 'native',
    async request<T>({ method = 'POST', path, body, signal, auth }: GeminiRequestOptions): Promise<T> {
      const result = await invokeFn<{ status: number; body: string }>('gemini_request', {
        method,
        url: buildUrl(path),
        bodyJson: body === undefined ? null : JSON.stringify(body),
        useStoredKey: auth.kind === 'native',
        apiKey: auth.kind === 'inline' ? auth.apiKey : auth.kind === 'ephemeral' ? auth.token : null,
        timeoutMs: 120_000,
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      if (signal.aborted) {
        throw new ProviderError({ kind: 'aborted', retryable: false, message: 'Request aborted' });
      }
      if (result.status < 200 || result.status >= 300) {
        throw toProviderError(result.status, result.body);
      }
      try {
        return JSON.parse(result.body) as T;
      } catch (error) {
        throw new ProviderError({
          kind: 'server',
          retryable: true,
          message: `The native gateway returned unreadable JSON (${String(error)}).`,
        });
      }
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Model discovery used by Settings (PLAN §16 "models change" mitigation). */
export interface ListedModel {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

export async function listModels(
  transport: GeminiTransport,
  auth: GeminiAuth,
  signal: AbortSignal,
): Promise<string[]> {
  const response = await transport.request<{ models?: ListedModel[] }>({
    method: 'GET',
    path: '/models?pageSize=200',
    signal,
    auth,
  });
  return (response.models ?? [])
    .map((model) => model.name ?? model.displayName ?? '')
    .filter((name) => name.length > 0);
}

export interface ListedVoice {
  name?: string;
  voiceId?: string;
  displayName?: string;
}

/** Voice library discovery; falls back to the curated list when unavailable. */
export async function listVoices(
  transport: GeminiTransport,
  auth: GeminiAuth,
  signal: AbortSignal,
): Promise<string[]> {
  const response = await transport.request<{ voices?: ListedVoice[] }>({
    method: 'GET',
    path: '/voices',
    signal,
    auth,
  });
  return (response.voices ?? [])
    .map((voice) => voice.voiceId ?? voice.name ?? voice.displayName ?? '')
    .map((name) => name.replace(/^voices\//, ''))
    .filter((name) => name.length > 0);
}
