import { ProviderError } from '../../types/model';
import type { LiveCredentials, LiveServerEvent, LiveSettings } from '../../types/live';
import type { LiveSession, LiveSessionFactory, SocketLike } from '../../audio/LiveAudioController';
import { base64ToBytes, bytesToBase64 } from '../../utils/pcm';
import { isTauriRuntime } from '../../storage';
import { invoke } from '@tauri-apps/api/core';
import {
  GEMINI_WS_CONSTRAINED_URL,
  GEMINI_WS_URL,
} from './ModelCapabilities';

/**
 * Gemini Live adapter (PLAN §8).
 *
 * Protocol (verified against the Live API WebSocket guide, Oct 2026):
 *  - key auth:      wss://.../v1beta.GenerativeService.BidiGenerateContent?key=…
 *  - ephemeral token: wss://.../v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=…
 *  - first client message is `{setup:{model, responseModalities, systemInstruction, speechConfig,…}}`
 *  - audio in:  `{realtimeInput:{audio:{data:<base64 PCM16 LE 16 kHz>, mimeType:'audio/pcm;rate=16000'}}}`
 *  - audio out: `serverContent.modelTurn.parts[].inlineData.data` (24 kHz PCM)
 *  - transcripts: `serverContent.inputTranscription.text` / `outputTranscription.text`
 *  - control: `serverContent.turnComplete`, `serverContent.interrupted`, `goAway`
 *
 * Not verified against the live service in this environment (needs a user key);
 * the transport is injectable so the state machine is still fully testable.
 */

export interface GeminiLiveAdapterOptions {
  /** Raw API key. Never persisted by this class. */
  apiKey?: string;
  /** Prefer an ephemeral token minted by the native gateway (PLAN §8.6). */
  useEphemeralToken?: boolean;
  /** Override for tests. */
  socketFactory?: (url: string) => SocketLike;
}

export interface RawServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    turnComplete?: boolean;
    interrupted?: boolean;
    generationComplete?: boolean;
  };
  goAway?: { timeLeft?: string };
  toolCall?: { functionCalls?: Array<{ name?: string; args?: Record<string, unknown> }> };
  error?: { message?: string; code?: number };
}

/**
 * Ephemeral token provisioning (PLAN §8.6).
 *
 * In the packaged app the request is made by Rust so the long-lived key stays in
 * the OS credential store; the renderer receives only a short-lived token that
 * works for Live alone.
 */
export async function fetchEphemeralToken(params: {
  apiKey?: string;
  modelId: string;
  systemInstruction: string;
  voiceName: string;
  signal: AbortSignal;
}): Promise<LiveCredentials> {
  if (!isTauriRuntime()) {
    if (!params.apiKey) {
      throw new ProviderError({
        kind: 'auth',
        retryable: false,
        message: 'A Gemini API key is required for Live mode.',
      });
    }
    return { kind: 'apiKey', token: params.apiKey };
  }

  const result = await invoke<{
    token: string;
    expireTime?: string;
    newSessionExpireTime?: string;
  }>('gemini_ephemeral_token', {
    modelId: params.modelId,
    systemInstruction: params.systemInstruction,
    voiceName: params.voiceName,
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });

  return {
    kind: 'ephemeral',
    token: result.token,
    expiresAt: result.expireTime,
    newSessionExpireTime: result.newSessionExpireTime,
  };
}

export function buildLiveSocketUrl(credentials: LiveCredentials): string {
  if (credentials.kind === 'ephemeral') {
    return `${GEMINI_WS_CONSTRAINED_URL}?access_token=${encodeURIComponent(credentials.token)}`;
  }
  return `${GEMINI_WS_URL}?key=${encodeURIComponent(credentials.token)}`;
}

export function buildSetupMessage(settings: LiveSettings): Record<string, unknown> {
  return {
    setup: {
      model: `models/${settings.modelId.replace(/^models\//, '')}`,
      responseModalities: ['AUDIO'],
      systemInstruction: settings.systemInstruction
        ? { parts: [{ text: settings.systemInstruction }] }
        : undefined,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voiceName } },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // 30-minute sessions; on goAway the controller resumes with the handle.
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

/** Normalise one raw server message into zero or more controller events. */
export function parseLiveMessage(raw: string): LiveServerEvent[] {
  let parsed: RawServerMessage;
  try {
    parsed = JSON.parse(raw) as RawServerMessage;
  } catch {
    return [];
  }
  const events: LiveServerEvent[] = [];

  if (parsed.setupComplete) {
    events.push({ type: 'setup_complete' });
  }
  if (parsed.error) {
    const code = parsed.error.code ?? 0;
    events.push({
      type: 'error',
      message: parsed.error.message ?? 'The Live session reported an error.',
      retryable: code === 1011 || code === 1006 || code === 429 || code >= 500,
    });
  }
  if (parsed.goAway) {
    events.push({ type: 'go_away', timeLeftMs: parseTimeLeft(parsed.goAway.timeLeft) });
  }
  if (parsed.toolCall?.functionCalls?.length) {
    for (const call of parsed.toolCall.functionCalls) {
      events.push({ type: 'tool_call', name: call.name ?? 'unknown', args: call.args ?? {} });
    }
  }

  const serverContent = parsed.serverContent;
  if (serverContent) {
    for (const part of serverContent.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (!inline?.data) continue;
      const mimeType = inline.mimeType ?? 'audio/pcm;rate=24000';
      const bytes = base64ToBytes(inline.data);
      events.push({
        type: 'audio',
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        sampleRate: parseRate(mimeType) ?? 24000,
      });
    }
    if (serverContent.inputTranscription?.text) {
      events.push({
        type: 'input_transcript',
        text: serverContent.inputTranscription.text,
        final: false,
      });
    }
    if (serverContent.outputTranscription?.text) {
      events.push({
        type: 'output_transcript',
        text: serverContent.outputTranscription.text,
        final: false,
      });
    }
    if (serverContent.interrupted) events.push({ type: 'interrupted' });
    if (serverContent.turnComplete) events.push({ type: 'turn_complete' });
    if (serverContent.generationComplete) events.push({ type: 'generation_complete' });
  }

  return events;
}

function parseRate(mimeType: string): number | undefined {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) return undefined;
  const rate = Number(match[1]);
  return Number.isFinite(rate) ? rate : undefined;
}

function parseTimeLeft(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (!match) return undefined;
  return Math.round(Number(match[1]) * 1000);
}

export function encodeAudioChunk(pcm16: Uint8Array, sampleRate: number): string {
  return JSON.stringify({
    realtimeInput: {
      audio: {
        data: bytesToBase64(pcm16),
        mimeType: `audio/pcm;rate=${sampleRate}`,
      },
    },
  });
}

export function encodeTextInput(text: string): string {
  return JSON.stringify({ realtimeInput: { text } });
}

export function encodeActivity(kind: 'start' | 'end'): string {
  return JSON.stringify({ realtimeInput: kind === 'start' ? { activityStart: {} } : { activityEnd: {} } });
}

/** Default Live session factory used by the app. */
export function createGeminiLiveSessionFactory(
  credentials: LiveCredentials,
  settings: LiveSettings,
  options: GeminiLiveAdapterOptions = {},
): LiveSessionFactory {
  return {
    open(): LiveSession {
      const url = buildLiveSocketUrl(credentials);
      const socket: SocketLike =
        options.socketFactory?.(url) ??
        (new WebSocket(url) as unknown as SocketLike);

      let closed = false;
      let seq = 0;
      const listeners = new Set<(event: LiveServerEvent) => void>();
      const errorListeners = new Set<(message: string, retryable: boolean) => void>();
      const closeListeners = new Set<(code: number, reason: string) => void>();

      const dispatch = (raw: string): void => {
        for (const event of parseLiveMessage(raw)) {
          seq += 1;
          if (event.type === 'error') {
            for (const listener of errorListeners) listener(event.message, event.retryable);
          }
          for (const listener of listeners) listener(event);
        }
      };

      socket.onopen = () => {
        socket.send(JSON.stringify(buildSetupMessage(settings)));
      };
      socket.onmessage = (event: { data: unknown }) => {
        const data = event.data;
        if (typeof data === 'string') {
          dispatch(data);
          return;
        }
        if (data instanceof ArrayBuffer) {
          dispatch(new TextDecoder().decode(new Uint8Array(data)));
          return;
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          void data.text().then(dispatch);
        }
      };
      socket.onerror = () => {
        for (const listener of errorListeners) {
          listener('The Live connection reported a transport error.', true);
        }
      };
      socket.onclose = (event: { code: number; reason: string }) => {
        closed = true;
        for (const listener of closeListeners) listener(event.code, event.reason);
      };

      return {
        get sequence(): number {
          return seq;
        },
        sendAudio(pcm16: Uint8Array, sampleRate: number): void {
          if (closed) return;
          socket.send(encodeAudioChunk(pcm16, sampleRate));
        },
        sendText(text: string): void {
          if (closed) return;
          socket.send(encodeTextInput(text));
        },
        sendActivity(kind: 'start' | 'end'): void {
          if (closed) return;
          socket.send(encodeActivity(kind));
        },
        onEvent(listener: (event: LiveServerEvent) => void): () => void {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onError(listener: (message: string, retryable: boolean) => void): () => void {
          errorListeners.add(listener);
          return () => errorListeners.delete(listener);
        },
        onClose(listener: (code: number, reason: string) => void): () => void {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
        close(): void {
          closed = true;
          try {
            socket.close();
          } catch {
            // Closing an already-closed socket is not an error worth surfacing.
          }
        },
      };
    },
  };
}
