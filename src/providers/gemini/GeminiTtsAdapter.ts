import { ProviderError, type AudioResult, type SpeechSegment, type TtsProvider } from '../../types/model';
import { isTauriRuntime } from '../../storage';
import { invoke } from '@tauri-apps/api/core';
import { base64ToBytes, parseWav, pcm16ToFloat32 } from '../../utils/pcm';
import {
  createFetchTransport,
  createNativeTransport,
  type GeminiAuth,
  type GeminiTransport,
} from './GeminiClient';
import { assertSupported } from './ModelCapabilities';
import { normalizeModelId } from './GeminiChatAdapter';

/**
 * Gemini TTS adapter (PLAN §7.2).
 *
 * Two request shapes are supported because the API moved to the interactions
 * endpoint while `generateContent` with `responseModalities: ["AUDIO"]` still
 * works for the 2.5 TTS models. The first shape that succeeds is remembered, so
 * a working configuration costs one extra request at most.
 *
 * Audio decoding: unary requests return WAV (24 kHz mono 16-bit); streaming
 * requests return headerless L16. Both are normalised to float samples here.
 */

export type TtsStrategy = 'interactions' | 'generate_content';

interface InteractionsResponse {
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; data?: string; mime_type?: string; mimeType?: string }>;
  }>;
  output_audio?: { data?: string; mime_type?: string };
  error?: { message?: string };
}

interface GenerateContentAudioResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

export interface GeminiTtsAdapterOptions {
  auth: GeminiAuth;
  transport?: GeminiTransport;
  strategy?: TtsStrategy;
}

export class GeminiTtsAdapter implements TtsProvider {
  private readonly transport: GeminiTransport;
  private readonly auth: GeminiAuth;
  private strategy: TtsStrategy;

  constructor(options: GeminiTtsAdapterOptions) {
    this.auth = options.auth;
    this.strategy = options.strategy ?? 'interactions';
    this.transport =
      options.transport ??
      (isTauriRuntime()
        ? createNativeTransport((cmd, args) => invoke(cmd, args))
        : createFetchTransport());
  }

  get currentStrategy(): TtsStrategy {
    return this.strategy;
  }

  async synthesize(input: SpeechSegment, signal: AbortSignal): Promise<AudioResult> {
    assertSupported('supportsTtsStreaming', input.modelId);
    if (!input.text.trim()) {
      throw new ProviderError({
        kind: 'bad_request',
        retryable: false,
        message: 'Nothing to speak: the segment text was empty.',
      });
    }

    const order: TtsStrategy[] =
      this.strategy === 'interactions' ? ['interactions', 'generate_content'] : ['generate_content', 'interactions'];

    let lastError: unknown;
    for (const strategy of order) {
      try {
        const result =
          strategy === 'interactions'
            ? await this.requestInteractions(input, signal)
            : await this.requestGenerateContent(input, signal);
        this.strategy = strategy;
        return result;
      } catch (error) {
        lastError = error;
        // Only a shape mismatch justifies trying the other endpoint; auth,
        // quota or network problems must surface immediately.
        if (error instanceof ProviderError && error.details.kind === 'bad_request') {
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError({ kind: 'unknown', retryable: false, message: 'Speech synthesis failed.' });
  }

  private async requestInteractions(input: SpeechSegment, signal: AbortSignal): Promise<AudioResult> {
    const body = {
      model: normalizeModelId(input.modelId),
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: input.text,
              annotations: input.style ? [{ type: 'speech_metadata', style: input.style }] : [],
            },
          ],
        },
      ],
      response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: input.voiceName }] },
    };

    const response = await this.transport.request<InteractionsResponse>({
      method: 'POST',
      path: '/interactions',
      body,
      signal,
      auth: this.auth,
    });

    const audio = extractInteractionAudio(response);
    if (!audio) {
      throw new ProviderError({
        kind: 'server',
        retryable: true,
        message: 'The speech service returned no audio.',
      });
    }
    return decodeAudio(audio.data, audio.mimeType);
  }

  private async requestGenerateContent(input: SpeechSegment, signal: AbortSignal): Promise<AudioResult> {
    const body = {
      contents: [{ role: 'user', parts: [{ text: buildStyledPrompt(input) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voiceName } },
        },
      },
    };
    const response = await this.transport.request<GenerateContentAudioResponse>({
      method: 'POST',
      path: `/models/${normalizeModelId(input.modelId)}:generateContent`,
      body,
      signal,
      auth: this.auth,
    });

    if (response.promptFeedback?.blockReason) {
      throw new ProviderError({
        kind: 'bad_request',
        retryable: false,
        message: `Speech synthesis was blocked (${response.promptFeedback.blockReason}).`,
      });
    }
    const inline = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
    if (!inline?.data) {
      throw new ProviderError({
        kind: 'bad_request',
        retryable: false,
        message: 'This model returned no audio for generateContent; trying the interactions endpoint.',
      });
    }
    return decodeAudio(inline.data, inline.mimeType ?? 'audio/L16;rate=24000');
  }
}

function extractInteractionAudio(
  response: InteractionsResponse,
): { data: string; mimeType: string } | undefined {
  const fromSteps = (response.steps ?? [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .filter((content) => content.type === 'audio' && content.data);
  const last = fromSteps[fromSteps.length - 1];
  if (last?.data) {
    return { data: last.data, mimeType: last.mime_type ?? last.mimeType ?? 'audio/wav' };
  }
  if (response.output_audio?.data) {
    return {
      data: response.output_audio.data,
      mimeType: response.output_audio.mime_type ?? 'audio/wav',
    };
  }
  return undefined;
}

/**
 * Style guidance for the generateContent shape: the transcript must stay
 * verbatim, so style travels as a short prefix instruction rather than as
 * markup inside the spoken text.
 */
function buildStyledPrompt(input: SpeechSegment): string {
  const pace = input.pace === 'normal' ? '' : ` at a ${input.pace} pace`;
  if (!input.style) return input.text;
  return `Read the following text aloud${pace} with this style: ${input.style}.\n\n${input.text}`;
}

export function decodeAudio(base64: string, mimeType: string): AudioResult {
  const bytes = base64ToBytes(base64);
  const normalizedMime = mimeType.toLowerCase();

  if (normalizedMime.includes('wav')) {
    const container = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const wav = parseWav(container);
    return { samples: wav.samples, sampleRate: wav.sampleRate, container, mimeType };
  }

  const rate = parseRateFromMime(mimeType) ?? 24000;
  if (normalizedMime.includes('mulaw') || normalizedMime.includes('alaw')) {
    return { samples: decodeCompanded(bytes, normalizedMime.includes('mulaw')), sampleRate: rate, mimeType };
  }
  return { samples: pcm16ToFloat32(bytes), sampleRate: rate, mimeType };
}

function parseRateFromMime(mimeType: string): number | undefined {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) return undefined;
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** G.711 expansion, used when a caller explicitly requests mulaw/alaw output. */
function decodeCompanded(bytes: Uint8Array, muLaw: boolean): Float32Array {
  const samples = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    const value = bytes[i] as number;
    if (muLaw) {
      const inverted = ~value & 0xff;
      const sign = inverted & 0x80 ? -1 : 1;
      const exponent = (inverted >> 4) & 0x07;
      const mantissa = inverted & 0x0f;
      const magnitude = ((mantissa << 3) + 0x84) << exponent;
      samples[i] = (sign * (magnitude - 0x84)) / 32768;
    } else {
      const inverted = value ^ 0x55;
      const sign = inverted & 0x80 ? 1 : -1;
      const exponent = (inverted >> 4) & 0x07;
      const mantissa = inverted & 0x0f;
      const magnitude = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
      samples[i] = (sign * magnitude) / 32768;
    }
  }
  return samples;
}
