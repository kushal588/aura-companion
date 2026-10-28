import type { ExpressionName, MemoryCategory, MemoryScope, VoicePace } from './emotion';
import type { StructuredTurn } from './turn';

/**
 * Provider contracts (PLAN §2.3). Gemini-specific code must never leak past
 * these interfaces: the orchestrator only knows about providers and a
 * capability registry.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatInput {
  /** Character persona plus operational rules, already assembled. */
  systemInstruction: string;
  /** Recent turns plus the current user turn. */
  messages: ChatMessage[];
  /** Untrusted retrieved memories, passed as contextual claims. */
  memories: Array<{ id: string; content: string; createdAt: string; category: string }>;
  modelId: string;
  temperature: number;
  maxOutputTokens: number;
  /** JSON schema handed to providers that support native structured output. */
  responseSchema: Record<string, unknown>;
  turnId: string;
}

export interface SpeechSegment {
  segmentId: string;
  turnId: string;
  text: string;
  voiceName: string;
  style: string;
  pace: VoicePace;
  modelId: string;
}

export interface AudioResult {
  /** Decoded mono float samples at `sampleRate`. */
  samples: Float32Array;
  sampleRate: number;
  /** Raw container bytes when the provider returned WAV; used for caching. */
  container?: ArrayBuffer;
  mimeType: string;
}

export interface AudioChunk {
  samples: Float32Array;
  sampleRate: number;
  index: number;
}

export interface TtsProvider {
  synthesize(input: SpeechSegment, signal: AbortSignal): Promise<AudioResult>;
  stream?(input: SpeechSegment, signal: AbortSignal): AsyncIterable<AudioChunk>;
}

export interface ChatProvider {
  generateTurn(input: ChatInput, signal: AbortSignal): Promise<string>;
}

export interface ProviderErrorDetails {
  kind:
    | 'auth'
    | 'quota'
    | 'rate_limit'
    | 'network'
    | 'timeout'
    | 'aborted'
    | 'cors'
    | 'bad_request'
    | 'server'
    | 'unknown';
  retryable: boolean;
  status?: number;
  message: string;
}

export class ProviderError extends Error {
  readonly details: ProviderErrorDetails;

  constructor(details: ProviderErrorDetails) {
    super(details.message);
    this.name = 'ProviderError';
    this.details = details;
  }
}

/** Capability registry (PLAN §2.3) — never assume a model does everything. */
export interface ModelCapabilities {
  supportsStructuredOutput: boolean;
  supportsTtsStreaming: boolean;
  supportsVoiceStyle: boolean;
  supportsLiveTranscription: boolean;
  supportsInterruption: boolean;
  supportsEphemeralTokens: boolean;
  contextWindow: number;
}

export interface ModelDescriptor {
  id: string;
  displayName: string;
  kind: 'text' | 'tts' | 'live';
  capabilities: ModelCapabilities;
}

export interface AvatarCharacterSpec {
  id: string;
  name: string;
  voiceName: string;
  expressionFallbacks?: Partial<Record<ExpressionName, ExpressionName>>;
}

/** Shape returned by the response validator. */
export interface ValidatedTurn extends StructuredTurn {
  /** Memories the model proposed that survived local filtering. */
  acceptedMemoryCandidates: Array<{
    content: string;
    category: MemoryCategory;
    scope: MemoryScope;
    confidence: number;
    importance: number;
  }>;
}
