/**
 * Live conversation types (PLAN §8). Audio-only: no camera or video input.
 */

export const LIVE_STATES = [
  'idle',
  'requesting_permission',
  'connecting',
  'ready',
  'listening',
  'user_speaking',
  'model_thinking',
  'model_speaking',
  'interrupted',
  'reconnecting',
  'error',
  'disconnected',
] as const;
export type LiveState = (typeof LIVE_STATES)[number];

/** What the UI is allowed to show; the controller is the only writer. */
export interface LiveStatus {
  state: LiveState;
  epoch: number;
  startedAt?: number;
  lastError?: string;
  micMuted: boolean;
  /** Bytes currently buffered for playback — surfaced so a soak test can watch it. */
  bufferedMs: number;
  droppedChunks: number;
}

export interface LiveSettings {
  modelId: string;
  voiceName: string;
  systemInstruction: string;
  /** Input sample rate the provider expects; the app resamples to this. */
  inputSampleRate: number;
  outputSampleRate: number;
  /** Mic chunk size in milliseconds (PLAN §8.3: 20–40 ms). */
  chunkMs: number;
  /** Hard cap on the playback jitter buffer, milliseconds. */
  maxBufferMs: number;
  /** Persist finalized transcripts into the conversation. Always user-visible. */
  saveTranscripts: boolean;
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  modelId: 'gemini-2.5-flash-native-audio-preview-12-2025',
  voiceName: 'Kore',
  systemInstruction: '',
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  chunkMs: 32,
  maxBufferMs: 1500,
  saveTranscripts: true,
};

/**
 * Normalised server events. The adapter translates raw provider messages into
 * these so the controller never parses provider JSON directly.
 */
export type LiveServerEvent =
  | { type: 'setup_complete' }
  | { type: 'audio'; data: ArrayBuffer; sampleRate: number }
  | { type: 'input_transcript'; text: string; final: boolean }
  | { type: 'output_transcript'; text: string; final: boolean }
  | { type: 'turn_complete' }
  | { type: 'interrupted' }
  | { type: 'generation_complete' }
  | { type: 'go_away'; timeLeftMs?: number }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'error'; message: string; retryable: boolean };

/** Live credentials are ephemeral by default (PLAN §8.6). */
export interface LiveCredentials {
  kind: 'ephemeral' | 'apiKey';
  /** Token value. Never logged, never persisted. */
  token: string;
  expiresAt?: string;
  newSessionExpireTime?: string;
}
