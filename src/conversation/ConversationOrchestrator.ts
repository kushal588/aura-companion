import type { ChatProvider, TtsProvider, AudioResult } from '../types/model';
import type { Store } from '../storage/types';
import type { MemoryService } from '../memory/MemoryService';
import type { MessageRecord, ConversationRecord, CharacterRecord } from '../types/entities';
import type { AvatarEvent } from '../types/events';
import type { StructuredTurn, TurnDiagnostics } from '../types/turn';
import { createId, createTurnId, nowIso } from '../utils/ids';
import { createTimeoutSignal, isRetryableError, withRetry } from '../utils/retry';
import { buildPrompt, buildTurnResponseSchema, type BuiltPrompt } from './PromptBuilder';
import { buildRepairInstruction, extractJsonCandidate, plainTextTurn, validateTurn } from './ResponseValidator';
import { estimateTokens, stripVocalTags } from '../utils/text';
import { buildSegmentEvents } from './EmotionStateMachine';
import { estimateDuration } from '../avatar/AvatarScheduler';

/**
 * Conversation orchestrator (PLAN §7.1).
 *
 * Order matters and is enforced by the tests:
 *  1. the user message is persisted *before* any network call;
 *  2. the assistant text is persisted *before* any speech synthesis, so a TTS
 *     failure can never lose a turn;
 *  3. animation events are scheduled against estimated playback offsets and are
 *     re-based on the real audio clock once audio exists;
 *  4. cancelling a turn discards queued speech and invalidates its events.
 */

export interface OrchestratorSettings {
  textModelId: string;
  ttsModelId: string;
  voiceName: string;
  temperature: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  /** Keep speech synthesis at most this many segments ahead of playback. */
  ttsQueueAhead: number;
}

export const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = {
  textModelId: 'gemini-2.5-flash',
  ttsModelId: 'gemini-2.5-flash-preview-tts',
  voiceName: 'Kore',
  temperature: 0.9,
  maxOutputTokens: 2048,
  requestTimeoutMs: 90_000,
  ttsQueueAhead: 2,
};

export interface SendTurnParams {
  character: CharacterRecord;
  conversation: ConversationRecord;
  text: string;
  sessionId: string;
  settings?: Partial<OrchestratorSettings>;
  signal?: AbortSignal;
  onUserMessage?: (message: MessageRecord) => void;
  onTurn?: (turn: StructuredTurn, events: AvatarEvent[]) => void;
  onSpeech?: (segmentId: string, result: AudioResult) => void;
  onStatus?: (status: string) => void;
}

export interface SendTurnResult {
  userMessage: MessageRecord;
  assistantMessage: MessageRecord;
  turn: StructuredTurn;
  events: AvatarEvent[];
  diagnostics: TurnDiagnostics;
  speech: Array<{ segmentId: string; result: AudioResult }>;
  speechError?: string;
  memory: { accepted: number; pending: number; rejected: number };
}

export interface OrchestratorDeps {
  store: Store;
  chat: ChatProvider;
  tts?: TtsProvider;
  memory: MemoryService;
  /** Injected clocks keep scheduling deterministic in tests. */
  now?: () => number;
}

export class ConversationOrchestrator {
  private readonly deps: OrchestratorDeps;
  private controller?: AbortController;
  private activeTurnId?: string;
  private cancelledTurns = new Set<string>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  get activeTurn(): string | undefined {
    return this.activeTurnId;
  }

  /** Cancel the in-flight turn: queued speech and events are dropped. */
  interrupt(): void {
    if (this.activeTurnId) {
      this.cancelledTurns.add(this.activeTurnId);
    }
    this.controller?.abort();
    this.controller = undefined;
  }

  async sendTextTurn(params: SendTurnParams): Promise<SendTurnResult> {
    const settings: OrchestratorSettings = { ...DEFAULT_ORCHESTRATOR_SETTINGS, ...params.settings };
    const turnId = createTurnId();
    const controller = new AbortController();
    this.controller = controller;
    this.activeTurnId = turnId;
    const signal = params.signal
      ? combineSignals(controller.signal, params.signal)
      : controller.signal;
    const startedAt = this.now();

    const userMessage: MessageRecord = {
      id: createId('msg'),
      conversationId: params.conversation.id,
      role: 'user',
      modality: 'text',
      bodyText: params.text,
      status: 'complete',
      createdAt: nowIso(),
      promptVersion: params.character.promptVersion,
    };

    // 1. Persist the user turn first, so nothing is lost if the model fails.
    if (!params.conversation.ephemeral) {
      await this.deps.store.appendMessage(userMessage);
    }
    params.onUserMessage?.(userMessage);

    const rankedMemories = await this.deps.memory.retrieve({
      characterId: params.character.id,
      query: params.text,
      limit: 6,
    });

    const recentMessages = params.conversation.ephemeral
      ? []
      : (await this.deps.store.listMessages(params.conversation.id, 16))
          .filter((message) => message.role !== 'system_event' && message.bodyText.trim().length > 0)
          .map((message) => ({
            role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            text: displayTextOf(message),
          }));

    const memories = rankedMemories.map((entry) => ({
      id: entry.memory.id,
      content: entry.memory.content,
      createdAt: entry.memory.createdAt,
      category: entry.memory.category,
    }));

    const prompt: BuiltPrompt = buildPrompt({
      character: params.character,
      memories,
      recentMessages,
      userInput: params.text,
    });

    const issues: string[] = [];
    let attempt = 0;
    let turn: StructuredTurn | undefined;

    try {
      // 2. Model call with transient-error retry, then a single repair attempt.
      const response = await withRetry(
        async (currentAttempt) => {
          attempt = currentAttempt;
          const timeout = createTimeoutSignal(signal, settings.requestTimeoutMs);
          try {
            const raw = await this.deps.chat.generateTurn(
              {
                systemInstruction: prompt.systemInstruction,
                messages: prompt.messages,
                memories,
                modelId: settings.textModelId,
                temperature: settings.temperature,
                maxOutputTokens: settings.maxOutputTokens,
                responseSchema: buildTurnResponseSchema(),
                turnId,
              },
              timeout.signal,
            );
            return raw;
          } finally {
            timeout.dispose();
          }
        },
        signal,
        { attempts: 3 },
      );

      const validation = validateTurn(response, turnId);
      if (validation.ok) {
        turn = validation.turn;
        issues.push(...validation.issues);
      } else {
        issues.push(...validation.issues);
        params.onStatus?.('The first response was malformed; asking the model to repair it.');
        const repairResponse = await this.deps.chat.generateTurn(
          {
            systemInstruction: prompt.systemInstruction,
            messages: [
              ...prompt.messages,
              { role: 'assistant', text: extractJsonCandidate(response) },
              {
                role: 'user',
                text: buildRepairInstruction(validation.issues, JSON.stringify(buildTurnResponseSchema())),
              },
            ],
            memories,
            modelId: settings.textModelId,
            temperature: 0,
            maxOutputTokens: settings.maxOutputTokens,
            responseSchema: buildTurnResponseSchema(),
            turnId,
          },
          signal,
        );
        const repaired = validateTurn(repairResponse, turnId);
        if (repaired.ok) {
          turn = repaired.turn;
          issues.push(...repaired.issues);
        } else {
          // Last resort: plain neutral text with the model's raw words.
          const salvage =
            repaired.salvagedText ??
            (validation.salvagedText ?? 'I had trouble forming that reply. Could you say it again?');
          turn = plainTextTurn(salvage, turnId, 'fallback');
          issues.push('Fell back to plain text after two malformed responses');
        }
      }
    } catch (error) {
      if (params.conversation.ephemeral) {
        throw error;
      }
      // Persist the failure so the history is honest about what happened.
      const errorMessage: MessageRecord = {
        id: createId('msg'),
        conversationId: params.conversation.id,
        role: 'assistant',
        modality: 'text',
        bodyText: '',
        status: 'error',
        createdAt: nowIso(),
        modelId: settings.textModelId,
        promptVersion: params.character.promptVersion,
        extraJson: JSON.stringify({ error: describeError(error) }),
      };
      await this.deps.store.appendMessage(errorMessage);
      throw error;
    } finally {
      if (this.activeTurnId === turnId) this.activeTurnId = undefined;
    }

    if (!turn) {
      throw new Error('The orchestrator produced no turn');
    }

    const latencyMs = this.now() - startedAt;

    const events = this.buildEvents({ turn, sessionId: params.sessionId });
    const diagnostics: TurnDiagnostics = {
      requestedAt: new Date(startedAt).toISOString(),
      latencyMs,
      modelId: settings.textModelId,
      attempt,
      origin: turn.origin,
      issues,
      promptTokensEstimate: prompt.estimatedTokens,
      responseTokensEstimate: estimateTokens(turn.segments.map((segment) => segment.text).join(' ')),
      memoriesUsed: rankedMemories.map((entry) => ({ id: entry.memory.id, content: entry.memory.content })),
    };

    const assistantMessage: MessageRecord = {
      id: createId('msg'),
      conversationId: params.conversation.id,
      role: 'assistant',
      modality: 'text',
      // Visible text never contains control tags or inline vocal tags.
      bodyText: turn.segments.map((segment) => stripVocalTags(segment.displayText)).join('\n\n'),
      status: 'complete',
      createdAt: nowIso(),
      modelId: settings.textModelId,
      promptVersion: params.character.promptVersion,
      extraJson: JSON.stringify({
        turnId: turn.turnId,
        origin: turn.origin,
        segments: turn.segments,
        diagnostics: { ...diagnostics, memoriesUsed: diagnostics.memoriesUsed.map((entry) => entry.id) },
      }),
    };

    // 3. Persist the assistant turn *before* any speech request.
    if (!params.conversation.ephemeral) {
      await this.deps.store.appendMessage(assistantMessage);
    }
    params.onTurn?.(turn, events);
    this.retitleIfNeeded(params.conversation, params.text, turn).catch(() => undefined);

    // 4. Speech: bounded queue, abort-aware, never blocks persistence.
    const speech: Array<{ segmentId: string; result: AudioResult }> = [];
    let speechError: string | undefined;

    if (this.deps.tts && signal.aborted === false) {
      params.onStatus?.('Speaking…');
      let index = 0;
      const queueAhead = Math.max(1, settings.ttsQueueAhead);
      const worker = async (): Promise<void> => {
        while (index < turn.segments.length) {
          if (this.cancelledTurns.has(turnId) || signal.aborted) return;
          const currentIndex = index;
          index += 1;
          const segment = turn.segments[currentIndex];
          if (!segment) return;
          try {
            const result = await this.deps.tts?.synthesize(
              {
                segmentId: segment.id,
                turnId,
                text: segment.text,
                voiceName: settings.voiceName,
                style: segment.voice.style,
                pace: segment.voice.pace,
                modelId: settings.ttsModelId,
              },
              signal,
            );
            if (!result) return;
            if (this.cancelledTurns.has(turnId) || signal.aborted) return;
            speech.push({ segmentId: segment.id, result });
            params.onSpeech?.(segment.id, result);
          } catch (error) {
            if (signal.aborted) return;
            speechError = describeError(error);
            // Keep the text turn: only the audio part failed.
            params.onStatus?.('The text reply is saved, but speech synthesis failed.');
            return;
          }
        }
      };

      await Promise.all(Array.from({ length: queueAhead }, () => worker()));
      if (speechError) {
        await this.deps.store.updateMessage(assistantMessage.id, {
          extraJson: JSON.stringify({
            turnId: turn.turnId,
            origin: turn.origin,
            segments: turn.segments,
            ttsError: speechError,
          }),
        });
      }
    } else if (!this.deps.tts) {
      params.onStatus?.('Saved. Speech is off.');
    }

    // 5. Memory candidates, after the turn is safely stored. Temporary chats
    // never create durable memories (PLAN §9.5).
    const outcome = params.conversation.ephemeral
      ? { accepted: [], pending: [], rejected: [] }
      : await this.deps.memory.processCandidates({
          characterId: params.character.id,
          sourceMessageId: assistantMessage.id,
          candidates: turn.memoryCandidates,
        });

    return {
      userMessage,
      assistantMessage,
      turn,
      events,
      diagnostics,
      speech,
      speechError,
      memory: {
        accepted: outcome.accepted.length,
        pending: outcome.pending.length,
        rejected: outcome.rejected.length,
      },
    };
  }

  private buildEvents(params: { turn: StructuredTurn; sessionId: string }): AvatarEvent[] {
    const events: AvatarEvent[] = [];
    let offset = 0;
    params.turn.segments.forEach((segment) => {
      const duration = estimateDuration(segment.text);
      events.push(
        ...buildSegmentEvents({
          sessionId: params.sessionId,
          turnId: params.turn.turnId,
          segmentId: segment.id,
          emotion: segment.emotion,
          intensity: segment.intensity,
          gesture: segment.gesture,
          startSeq: events.length + 1,
          atAudioSeconds: offset,
          durationSeconds: duration,
        }),
      );
      offset += duration;
    });
    return events;
  }

  private async retitleIfNeeded(
    conversation: ConversationRecord,
    userText: string,
    _turn: StructuredTurn,
  ): Promise<void> {
    if (conversation.ephemeral) return;
    const stored = await this.deps.store.getConversation(conversation.id);
    if (!stored || stored.title !== 'New chat') return;
    const title = userText.trim().slice(0, 60) || 'New chat';
    await this.deps.store.saveConversation({ ...stored, title, updatedAt: nowIso() });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function displayTextOf(message: MessageRecord): string {
  if (!message.extraJson) return message.bodyText;
  try {
    const parsed = JSON.parse(message.extraJson) as { segments?: Array<{ displayText?: string }> };
    if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
      return parsed.segments.map((segment) => segment.displayText ?? '').join(' ');
    }
  } catch {
    // Fall through to the stored body text.
  }
  return message.bodyText;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function combineSignals(primary: AbortSignal, secondary: AbortSignal): AbortSignal {
  if (secondary.aborted) return secondary;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  primary.addEventListener('abort', abort, { once: true });
  secondary.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

export { isRetryableError };
