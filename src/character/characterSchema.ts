import type { CharacterRecord } from '../types/entities';
import { nowIso } from '../utils/ids';

/**
 * Character manifest (PLAN §4.1, §4.2).
 *
 * A character is a portable package: metadata plus references to an avatar,
 * animation clips and a personality prompt. It contains no executable content,
 * and nothing in it is trusted as an instruction.
 */

export const CHARACTER_SCHEMA_VERSION = 1;

export interface CharacterManifest {
  schemaVersion: number;
  id: string;
  name: string;
  avatar?: string;
  promptFile?: string;
  voice: { provider: 'gemini'; voiceId: string };
  traits: { curiosity: number; playfulness: number; talkativeness: number };
  motionMap: Record<string, string[]>;
  memoryScope: 'user' | 'character';
  license: string;
}

export const DEFAULT_CHARACTER_PROMPT = `You are Aiko: warm, curious and quick to laugh, with a dry sense of humour.
You ask follow-up questions because you are genuinely interested, not to fill silence.
You keep answers short enough to be spoken aloud, and you never pretend to have a body.`;

export function manifestFor(id: string, name: string, voiceId = 'Kore'): string {
  const manifest: CharacterManifest = {
    schemaVersion: CHARACTER_SCHEMA_VERSION,
    id,
    name,
    voice: { provider: 'gemini', voiceId },
    traits: { curiosity: 0.9, playfulness: 0.7, talkativeness: 0.6 },
    motionMap: {
      neutral: ['idle'],
      happy: ['idle'],
      excited: ['idle'],
      sad: ['idle'],
      concerned: ['idle'],
      angry: ['idle'],
      confused: ['idle'],
      curious: ['idle'],
      surprised: ['idle'],
      playful: ['idle'],
      thinking: ['idle'],
      sleepy: ['idle'],
    },
    memoryScope: 'character',
    license: 'user-supplied',
  };
  return JSON.stringify(manifest, null, 2);
}

export function characterFromInput(input: { id: string; name: string; prompt: string }): CharacterRecord {
  const timestamp = nowIso();
  return {
    id: input.id,
    name: input.name.trim() || 'Character',
    manifestJson: manifestFor(input.id, input.name),
    promptText: input.prompt.trim() || DEFAULT_CHARACTER_PROMPT,
    promptVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function parseManifest(manifestJson: string): CharacterManifest | undefined {
  try {
    const parsed = JSON.parse(manifestJson) as Partial<CharacterManifest>;
    if (!parsed.id || !parsed.name) return undefined;
    return {
      schemaVersion: parsed.schemaVersion ?? CHARACTER_SCHEMA_VERSION,
      id: parsed.id,
      name: parsed.name,
      avatar: parsed.avatar,
      promptFile: parsed.promptFile,
      voice: parsed.voice ?? { provider: 'gemini', voiceId: 'Kore' },
      traits: parsed.traits ?? { curiosity: 0.6, playfulness: 0.5, talkativeness: 0.5 },
      motionMap: parsed.motionMap ?? {},
      memoryScope: parsed.memoryScope ?? 'character',
      license: parsed.license ?? 'user-supplied',
    };
  } catch {
    return undefined;
  }
}
