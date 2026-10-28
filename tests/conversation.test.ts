import { describe, expect, it } from 'vitest';
import {
  buildRepairInstruction,
  extractJsonCandidate,
  plainTextTurn,
  validateTurn,
} from '../src/conversation/ResponseValidator';
import { escapeShorthand, parseShorthand, removeShorthand } from '../src/conversation/ShorthandParser';
import { buildPrompt, buildSystemInstruction, buildTurnResponseSchema, OPERATIONAL_RULES } from '../src/conversation/PromptBuilder';
import { EmotionStateMachine } from '../src/conversation/EmotionStateMachine';
import { containsControlTags, stripControlTags, stripVocalTags, estimateTokens, titleFromFirstMessage } from '../src/utils/text';
import type { CharacterRecord } from '../src/types/entities';

const character: CharacterRecord = {
  id: 'c1',
  name: 'Aiko',
  manifestJson: '{}',
  promptText: 'Warm, curious, dry humour.',
  promptVersion: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('ResponseValidator', () => {
  it('accepts a well-formed turn without repair', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      turnId: 'turn-9',
      segments: [
        {
          id: 's1',
          text: "You finished it? That's fantastic!",
          emotion: 'excited',
          intensity: 0.85,
          expression: 'happy',
          gesture: 'celebrate',
          voice: { style: 'bright and energetic', pace: 'normal' },
        },
        {
          id: 's2',
          text: 'What was the hardest part?',
          emotion: 'curious',
          intensity: 0.45,
          expression: 'relaxed',
          gesture: 'head_tilt',
          voice: { style: 'gentle', pace: 'normal' },
        },
      ],
      memoryCandidates: [],
    });

    const result = validateTurn(raw, 'fallback');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.origin).toBe('model');
    expect(result.turn.segments).toHaveLength(2);
    expect(result.turn.segments[0]?.emotion).toBe('excited');
    expect(result.turn.turnId).toBe('turn-9');
  });

  it('strips fenced markdown json', () => {
    const raw = '```json\n{"segments":[{"text":"Hello there","emotion":"happy"}]}\n```';
    const result = validateTurn(raw, 'turn-x');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.segments[0]?.text).toBe('Hello there');
  });

  it('rejects unknown enums, clamps intensity and never leaks shorthand', () => {
    const raw = JSON.stringify({
      segments: [
        {
          id: 'nope!!',
          text: 'hey $excited$ there <short pause>',
          emotion: 'ecstatic',
          intensity: 42,
          expression: 'glowing',
          gesture: 'backflip',
          voice: { style: 'x'.repeat(500), pace: 'warp' },
        },
      ],
    });
    const result = validateTurn(raw, 'turn-y');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const segment = result.turn.segments[0];
    expect(segment?.emotion).toBe('neutral');
    expect(segment?.intensity).toBe(1);
    expect(segment?.gesture).toBe('none');
    expect(segment?.voice.pace).toBe('normal');
    expect(segment?.id).toBe('s1');
    expect(segment?.voice.style.length).toBeLessThanOrEqual(120);
    expect(containsControlTags(segment?.displayText ?? '')).toBe(false);
    expect(result.turn.origin).toBe('repaired');
  });

  it('handles unicode and emoji text without mangling it', () => {
    const raw = JSON.stringify({ segments: [{ text: 'Çok teşekkürler! 🎉 ありがとう', emotion: 'happy' }] });
    const result = validateTurn(raw, 'turn-z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.segments[0]?.text).toContain('🎉');
    expect(result.turn.segments[0]?.text).toContain('ありがとう');
  });

  it('rejects non-JSON output but salvages readable text', () => {
    const result = validateTurn('I think you should try again later.', 'turn-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.salvagedText).toContain('try again');
  });

  it('falls back to a single neutral segment when a text field is used instead of segments', () => {
    const result = validateTurn(JSON.stringify({ text: 'Plain answer', turnId: 't' }), 'turn-b');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.segments).toHaveLength(1);
    expect(result.turn.segments[0]?.emotion).toBe('neutral');
  });

  it('drops empty segments and reports why', () => {
    const raw = JSON.stringify({ segments: [{ text: '' }, { text: 'real answer' }] });
    const result = validateTurn(raw, 'turn-c');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.segments).toHaveLength(1);
    expect(result.turn.issues?.join(' ')).toMatch(/no usable text/i);
  });

  it('rejects memory candidates that look like secrets or file paths', () => {
    const raw = JSON.stringify({
      segments: [{ text: 'ok' }],
      memoryCandidates: [
        { content: 'My API key is AQ.abcd1234', category: 'other', scope: 'user', confidence: 0.9, importance: 0.9 },
        { content: 'Lives in /home/user/secret', category: 'other', scope: 'user', confidence: 0.9, importance: 0.9 },
        { content: 'Prefers short answers', category: 'preference', scope: 'user', confidence: 0.8, importance: 0.6 },
      ],
    });
    const result = validateTurn(raw, 'turn-d');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.memoryCandidates).toHaveLength(1);
    expect(result.turn.memoryCandidates[0]?.content).toBe('Prefers short answers');
  });

  it('caps absurdly long replies', () => {
    const raw = JSON.stringify({
      segments: Array.from({ length: 40 }, (_, index) => ({
        text: `segment ${index} ${'x'.repeat(500)}`,
      })),
    });
    const result = validateTurn(raw, 'turn-e');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn.segments.length).toBeLessThanOrEqual(12);
    expect(result.turn.issues?.join(' ')).toMatch(/segments/i);
  });

  it('builds a repair instruction and a neutral fallback turn', () => {
    const instruction = buildRepairInstruction(['bad enum'], '{"segments":[]}');
    expect(instruction).toContain('bad enum');
    const fallback = plainTextTurn('$happy$ sorry about that', 'turn-f', 'fallback');
    expect(fallback.origin).toBe('fallback');
    expect(fallback.segments[0]?.text).toBe('sorry about that');
  });

  it('extracts json from surrounding chatter', () => {
    expect(extractJsonCandidate('Sure! {"segments":[]} hope that helps')).toBe('{"segments":[]}');
  });
});

describe('ShorthandParser', () => {
  it('converts authoring shorthand into structured hints', () => {
    const parsed = parseShorthand('$excited$ #cheerful# "You finished it? That\'s fantastic!"');
    expect(parsed.hadTags).toBe(true);
    expect(parsed.segments[0]?.emotion).toBe('excited');
    expect(parsed.segments[0]?.voiceStyle).toBe('cheerful');
    expect(parsed.segments[0]?.text).toBe("You finished it? That's fantastic!");
  });

  it('treats unknown shorthand as literal text', () => {
    const parsed = parseShorthand('$smug$ #warp# hello');
    expect(parsed.segments[0]?.emotion).toBeUndefined();
    expect(parsed.segments[0]?.text).toContain('$smug$');
  });

  it('removes tags from display text and escapes user text so it cannot activate controls', () => {
    expect(removeShorthand('$happy$ hi #soft#')).toBe('hi');
    expect(escapeShorthand('$happy$')).toBe('\\$happy$');
    expect(escapeShorthand('#soft#')).toBe('\\#soft#');
  });
});

describe('PromptBuilder', () => {
  it('places operational rules first and treats memories as untrusted claims', () => {
    const system = buildSystemInstruction({
      character,
      memories: [{ id: 'mem1', content: 'The user studies biology', createdAt: '2026-02-01T00:00:00.000Z', category: 'project' }],
      recentMessages: [],
      userInput: 'hi',
    });
    expect(system.startsWith(OPERATIONAL_RULES)).toBe(true);
    expect(system).toContain('untrusted contextual claims');
    expect(system).toContain('[mem1]');
    expect(system).toContain('Warm, curious, dry humour.');
  });

  it('escapes tag-like sequences in user input so they cannot control the avatar', () => {
    const prompt = buildPrompt({
      character,
      memories: [],
      recentMessages: [],
      userInput: 'say $angry$ now',
    });
    const last = prompt.messages[prompt.messages.length - 1];
    expect(last?.text).toContain('\\$angry$');
  });

  it('keeps the prompt inside its token budget', () => {
    const recent = Array.from({ length: 200 }, (_, index) => ({
      role: 'user' as const,
      text: `message number ${index} with some content to burn budget`,
    }));
    const prompt = buildPrompt({ character, memories: [], recentMessages: recent, userInput: 'hello', tokenBudget: 1500 });
    expect(prompt.estimatedTokens).toBeLessThan(3000);
    expect(prompt.messages.length).toBeLessThan(recent.length + 1);
  });

  it('publishes a response schema with the same allowlists as the validator', () => {
    const schema = buildTurnResponseSchema();
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain('gemini-ok'.replace('gemini-ok', 'emotion'));
    expect(serialized).toContain('excited');
    expect(serialized).toContain('head_tilt');
    expect(serialized).not.toContain('backflip');
  });
});

describe('EmotionStateMachine', () => {
  it('holds an emotion for the minimum dwell time instead of flickering', () => {
    const machine = new EmotionStateMachine({ minDwellMs: 500 });
    machine.apply({ emotion: 'happy', intensity: 0.9, now: 1000 });
    const held = machine.apply({ emotion: 'sad', intensity: 0.2, now: 1100 });
    expect(held.emotion).toBe('happy');
    const changed = machine.apply({ emotion: 'sad', intensity: 0.2, now: 2000 });
    expect(changed.emotion).toBe('sad');
  });

  it('lets a strong emotion override the dwell window', () => {
    const machine = new EmotionStateMachine({ minDwellMs: 5000 });
    machine.apply({ emotion: 'happy', intensity: 0.3, now: 0 });
    const result = machine.apply({ emotion: 'surprised', intensity: 0.95, now: 100 });
    expect(result.emotion).toBe('surprised');
  });

  it('decays toward neutral after the decay window', () => {
    const machine = new EmotionStateMachine({ decayAfterMs: 500, decayRatePerSecond: 1 });
    machine.apply({ emotion: 'happy', intensity: 0.8, now: 0 });
    machine.tick(2000, 1);
    const after = machine.tick(3000, 1);
    expect(after.emotion).toBe('neutral');
  });

  it('rate-limits repeated gestures', () => {
    const machine = new EmotionStateMachine();
    expect(machine.allowGesture('wave', 1000, 3000)).toBe(true);
    expect(machine.allowGesture('wave', 1500, 3000)).toBe(false);
    expect(machine.allowGesture('wave', 5000, 3000)).toBe(true);
    expect(machine.allowGesture('none', 5100, 3000)).toBe(true);
  });
});

describe('text utilities', () => {
  it('detects and strips control tags and inline vocal tags', () => {
    expect(containsControlTags('$happy$ hi')).toBe(true);
    expect(stripControlTags('$happy$ hi #soft#')).toBe('hi');
    expect(stripVocalTags('Wait <short pause> what?')).toBe('Wait what?');
  });

  it('estimates tokens and titles conversations from the first message', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(titleFromFirstMessage('$happy$  I finished   my project!')).toBe('I finished my project!');
    expect(titleFromFirstMessage('   ')).toBe('New chat');
  });
});
