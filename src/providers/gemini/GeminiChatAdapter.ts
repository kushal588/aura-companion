import { ProviderError, type ChatInput, type ChatProvider } from '../../types/model';
import { isTauriRuntime } from '../../storage';
import { invoke } from '@tauri-apps/api/core';
import {
  createFetchTransport,
  createNativeTransport,
  type GeminiAuth,
  type GeminiTransport,
} from './GeminiClient';
import { assertSupported } from './ModelCapabilities';

/**
 * Gemini text adapter (PLAN §7.1 step 5).
 *
 * Uses `models/{model}:generateContent` with the native structured-output
 * fields (`responseMimeType: application/json` + `responseSchema`) so the model
 * returns the turn schema directly. A single attempt per call: retries, timeouts
 * and the repair pass live in the orchestrator so their behaviour is testable
 * without a network.
 */

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export interface GeminiChatAdapterOptions {
  auth: GeminiAuth;
  transport?: GeminiTransport;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ChatGenerationResult {
  text: string;
  usage: { promptTokens: number; responseTokens: number; totalTokens: number };
}

export class GeminiChatAdapter implements ChatProvider {
  private readonly transport: GeminiTransport;
  private readonly options: GeminiChatAdapterOptions;

  constructor(options: GeminiChatAdapterOptions) {
    this.options = options;
    this.transport =
      options.transport ??
      (isTauriRuntime()
        ? createNativeTransport((cmd, args) => invoke(cmd, args))
        : createFetchTransport());
  }

  static createResponseSchemaAware(input: ChatInput): boolean {
    return input.responseSchema !== undefined;
  }

  async generateTurnRaw(input: ChatInput, signal: AbortSignal): Promise<ChatGenerationResult> {
    assertSupported('supportsStructuredOutput', input.modelId);

    const body = {
      contents: input.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.text }],
      })),
      systemInstruction: { parts: [{ text: input.systemInstruction }] },
      generationConfig: {
        temperature: input.temperature,
        maxOutputTokens: input.maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: input.responseSchema,
      },
    };

    const response = await this.transport.request<GenerateContentResponse>({
      method: 'POST',
      path: `/models/${normalizeModelId(input.modelId)}:generateContent`,
      body,
      signal,
      auth: this.options.auth,
    });

    if (response.promptFeedback?.blockReason) {
      throw new ProviderError({
        kind: 'bad_request',
        retryable: false,
        message: `The request was blocked by the model's safety filters (${response.promptFeedback.blockReason}).`,
      });
    }

    const candidate = response.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (!text) {
      throw new ProviderError({
        kind: 'server',
        retryable: true,
        message: `The model returned an empty response${candidate?.finishReason ? ` (${candidate.finishReason})` : ''}.`,
      });
    }

    return {
      text,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
        responseTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  }

  async generateTurn(input: ChatInput, signal: AbortSignal): Promise<string> {
    const result = await this.generateTurnRaw(input, signal);
    return result.text;
  }
}

export function normalizeModelId(modelId: string): string {
  return modelId.replace(/^models\//, '').trim();
}

/** Convenience for the connection test in onboarding/settings. */
export async function testGeminiTextConnection(params: {
  auth: GeminiAuth;
  modelId: string;
  signal: AbortSignal;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const adapter = new GeminiChatAdapter({ auth: params.auth, maxOutputTokens: 64 });
  try {
    await adapter.generateTurnRaw(
      {
        systemInstruction: 'Reply with JSON only.',
        messages: [{ role: 'user', text: 'Return {"ok":true} as JSON.' }],
        memories: [],
        modelId: params.modelId,
        temperature: 0,
        maxOutputTokens: 64,
        responseSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          propertyOrdering: ['ok'],
        },
        turnId: 'connection-test',
      },
      params.signal,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
