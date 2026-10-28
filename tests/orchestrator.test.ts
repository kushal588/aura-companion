import { describe, expect, it, vi } from 'vitest';
import { createTestStore } from '../src/storage';
import { ConversationOrchestrator } from '../src/conversation/ConversationOrchestrator';
import { MemoryService } from '../src/memory/MemoryService';
import { characterFromInput } from '../src/character/characterSchema';
import type { AudioResult, ChatInput, ChatProvider, SpeechSegment, TtsProvider } from '../src/types/model';
import type { ConversationRecord } from '../src/types/entities';
import { containsControlTags } from '../src/utils/text';

const character = characterFromInput({ id: 'aiko', name: 'Aiko', prompt: 'Warm and curious.' });

function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conv-1',
    characterId: character.id,
    title: 'New chat',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

const validTurn = JSON.stringify({
  schemaVersion: 1,
  turnId: 'turn-1',
  segments: [
    {
      id: 's1',
      text: "You finished it? That's fantastic! <short pause> Really!",
      emotion: 'excited',
      intensity: 0.85,
      expression: 'happy',
      gesture: 'celebrate',
      voice: { style: 'bright and energetic', pace: 'normal' },
    },
    {
      id: 's2',
      text: 'What was the hardest part of $excited$ the project?',
      emotion: 'curious',
      intensity: 0.45,
      expression: 'relaxed',
      gesture: 'head_tilt',
      voice: { style: 'gentle', pace: 'normal' },
    },
  ],
  memoryCandidates: [
    {
      content: 'The user finished their Avalon project',
      category: 'project',
      scope: 'character',
      confidence: 0.85,
      importance: 0.7,
    },
  ],
});

class ScriptedChat implements ChatProvider {
  readonly calls: ChatInput[] = [];
  constructor(private readonly responses: string[]) {}

  async generateTurn(input: ChatInput): Promise<string> {
    this.calls.push(input);
    return this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)] ?? '';
  }
}

class ThrowingTts implements TtsProvider {
  async synthesize(_input: SpeechSegment): Promise<AudioResult> {
    throw new Error('speech service unavailable');
  }
}

class WorkingTts implements TtsProvider {
  delayMs = 0;
  async synthesize(input: SpeechSegment, signal: AbortSignal): Promise<AudioResult> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (signal.aborted) throw new Error('aborted');
    void input.segmentId;
    return {
      samples: new Float32Array(64).fill(0.1),
      sampleRate: 24000,
      mimeType: 'audio/l16',
    };
  }
}

describe('ConversationOrchestrator', () => {
  it('persists the user turn first and the assistant turn before speaking', async () => {
    const store = createTestStore();
    const order: string[] = [];
    const chat = new ScriptedChat([validTurn]);
    const orchestrator = new ConversationOrchestrator({ store, chat, memory: new MemoryService(store) });

    const originalAppend = store.appendMessage.bind(store);
    store.appendMessage = async (record) => {
      order.push(`${record.role}:${record.status}`);
      return originalAppend(record);
    };

    const result = await orchestrator.sendTextTurn({
      character,
      conversation: conversation(),
      text: 'I finished my project!',
      sessionId: 'session-1',
    });

    expect(order[0]).toBe('user:complete');
    expect(order[1]).toBe('assistant:complete');
    expect(result.turn.origin).toBe('model');
    expect(result.turn.segments).toHaveLength(2);
    expect(result.events.length).toBeGreaterThan(6);
    expect(result.memory.accepted).toBe(1);
  });

  it('keeps the text turn when speech synthesis fails', async () => {
    const store = createTestStore();
    const orchestrator = new ConversationOrchestrator({
      store,
      chat: new ScriptedChat([validTurn]),
      tts: new ThrowingTts(),
      memory: new MemoryService(store),
    });

    const result = await orchestrator.sendTextTurn({
      character,
      conversation: conversation(),
      text: 'I finished my project!',
      sessionId: 'session-1',
    });

    expect(result.speech).toHaveLength(0);
    expect(result.speechError).toMatch(/unavailable/);
    const stored = await store.listMessages('conv-1');
    expect(stored).toHaveLength(2);
    const assistant = stored[1];
    expect(assistant?.status).toBe('complete');
    expect(assistant?.bodyText.length).toBeGreaterThan(10);
  });

  it('never stores control tags or inline vocal tags in visible text', async () => {
    const store = createTestStore();
    const orchestrator = new ConversationOrchestrator({
      store,
      chat: new ScriptedChat([validTurn]),
      tts: new WorkingTts(),
      memory: new MemoryService(store),
    });

    const result = await orchestrator.sendTextTurn({
      character,
      conversation: conversation(),
      text: 'I finished my project!',
      sessionId: 'session-1',
    });

    const visible = result.assistantMessage.bodyText;
    expect(containsControlTags(visible)).toBe(false);
    expect(visible).not.toContain('<short pause>');
    expect(visible).not.toMatch(/<[a-z][a-z -]{1,24}>/i);
    // The spoken text keeps the inline tag on purpose, the visible one does not.
    expect(result.turn.segments[0]?.text).toContain('<short pause>');
  });

  it('repairs a malformed response once and then falls back to plain text', async () => {
    const store = createTestStore();
    const chat = new ScriptedChat(['{"segments":[{"emotion":"happy"}]}', '{"segments":[{"text":"Repaired reply"}]}']);
    const orchestrator = new ConversationOrchestrator({ store, chat, memory: new MemoryService(store) });

    const repaired = await orchestrator.sendTextTurn({
      character,
      conversation: conversation(),
      text: 'hello',
      sessionId: 'session-1',
    });
    expect(repaired.turn.origin).toBe('repaired');
    expect(repaired.turn.segments[0]?.text).toBe('Repaired reply');
    expect(chat.calls.length).toBe(2);

    const store2 = createTestStore();
    const alwaysBroken = new ScriptedChat(['not json at all', 'still not json']);
    const orchestrator2 = new ConversationOrchestrator({
      store: store2,
      chat: alwaysBroken,
      memory: new MemoryService(store2),
    });
    const fallback = await orchestrator2.sendTextTurn({
      character,
      conversation: conversation(),
      text: 'hello',
      sessionId: 'session-2',
    });
    expect(fallback.turn.origin).toBe('fallback');
    expect(fallback.turn.segments).toHaveLength(1);
    expect(fallback.turn.segments[0]?.emotion).toBe('neutral');
  });

  it('uses approved memories on a later turn and not ones the user deleted', async () => {
    const store = createTestStore();
    const memory = new MemoryService(store);
    const orchestrator = new ConversationOrchestrator({ store, chat: new ScriptedChat([validTurn]), memory });

    await orchestrator.sendTextTurn({
      character,
      conversation: conversation(),
      text: 'I finished my Avalon project!',
      sessionId: 'session-1',
    });
    const memories = await memory.list({ characterId: character.id });
    expect(memories).toHaveLength(1);

    const memoryService = new MemoryService(store);
    const second = await new ConversationOrchestrator({
      store,
      chat: new ScriptedChat([validTurn]),
      memory: memoryService,
    }).sendTextTurn({
      character,
      conversation: conversation({ id: 'conv-2' }),
      text: 'How is the Avalon project going?',
      sessionId: 'session-2',
    });
    expect(second.diagnostics.memoriesUsed.length).toBeGreaterThan(0);

    await memory.remove(memories[0]!.id);
    const third = await new ConversationOrchestrator({
      store,
      chat: new ScriptedChat([validTurn]),
      memory: new MemoryService(store),
    }).sendTextTurn({
      character,
      conversation: conversation({ id: 'conv-3' }),
      text: 'How is the Avalon project going?',
      sessionId: 'session-3',
    });
    expect(third.diagnostics.memoriesUsed).toHaveLength(0);
  });

  it('does not persist anything for temporary chats', async () => {
    const store = createTestStore();
    const orchestrator = new ConversationOrchestrator({
      store,
      chat: new ScriptedChat([validTurn]),
      memory: new MemoryService(store),
    });
    await orchestrator.sendTextTurn({
      character,
      conversation: conversation({ id: 'temp', ephemeral: true }),
      text: 'secret message',
      sessionId: 'session-1',
    });
    expect(await store.listMessages('temp')).toHaveLength(0);
    expect(await store.listMemories({ characterId: character.id })).toHaveLength(0);
  });

  it('drops queued speech when the turn is interrupted', async () => {
    const store = createTestStore();
    const tts = new WorkingTts();
    tts.delayMs = 30;
    const onSpeech = vi.fn();
    const orchestrator = new ConversationOrchestrator({
      store,
      chat: new ScriptedChat([validTurn]),
      tts,
      memory: new MemoryService(store),
    });

    const result = await orchestrator.sendTextTurn({
      character,
      conversation: conversation(),
      text: 'I finished my project!',
      sessionId: 'session-1',
      onSpeech,
      // Interrupt the moment the text is saved: queued speech must not play.
      onTurn: () => orchestrator.interrupt(),
    });

    // The text turn is still saved; only the audio part is cut short.
    const stored = await store.listMessages('conv-1');
    expect(stored.some((message) => message.role === 'assistant' && message.status === 'complete')).toBe(true);
    expect(onSpeech).not.toHaveBeenCalled();
    expect(result.speech).toHaveLength(0);
  });

  it('writes an error message when the model call fails outright', async () => {
    const store = createTestStore();
    const failing = {
      generateTurn: async () => {
        throw new Error('network down');
      },
    } as unknown as ChatProvider;
    const orchestrator = new ConversationOrchestrator({ store, chat: failing, memory: new MemoryService(store) });

    await expect(
      orchestrator.sendTextTurn({
        character,
        conversation: conversation(),
        text: 'hello',
        sessionId: 'session-1',
      }),
    ).rejects.toThrow(/network down/);

    const stored = await store.listMessages('conv-1');
    expect(stored.map((message) => message.status)).toEqual(['complete', 'error']);
  });
});
