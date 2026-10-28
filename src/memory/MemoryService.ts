import type { MemoryQuery } from '../storage/types';
import type { MemoryRecord } from '../types/entities';
import type { MemoryCandidate } from '../types/turn';
import { createId, nowIso } from '../utils/ids';
import { isDuplicateMemory, retrieveMemories, tokenOverlap, type RankedMemory } from './retrieval';

export type MemoryMode = 'manual' | 'auto_review' | 'disabled';

export interface MemoryServiceOptions {
  mode?: MemoryMode;
  /** Minimum confidence for a candidate to be considered durable. */
  minConfidence?: number;
  /** Similarity above which two facts are considered contradictory. */
  contradictionThreshold?: number;
}

export interface ExtractedCandidate extends MemoryCandidate {
  duplicateOf?: string;
  supersedes?: string;
  reason?: string;
}

export interface MemoryExtractionOutcome {
  accepted: MemoryRecord[];
  pending: ExtractedCandidate[];
  rejected: Array<{ candidate: MemoryCandidate; reason: string }>;
}

interface MemoryStore {
  listMemories(query: MemoryQuery): Promise<MemoryRecord[]>;
  upsertMemory(record: MemoryRecord): Promise<void>;
  updateMemory(id: string, patch: Partial<MemoryRecord>): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  searchMemories(query: MemoryQuery): Promise<MemoryRecord[]>;
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, valueJson: string): Promise<void>;
}

const MODE_SETTING_KEY = 'memory.mode';

/**
 * Durable memory service (PLAN §9.3, §9.4).
 *
 * Three distinct things are kept apart: conversation history (all messages),
 * working context (recent turns + summary) and durable memory (selected facts
 * with provenance). Not every sentence becomes a memory, and a deleted memory
 * can never be retrieved again.
 */
export class MemoryService {
  private readonly store: MemoryStore;
  private readonly options: Required<MemoryServiceOptions>;

  constructor(store: MemoryStore, options: MemoryServiceOptions = {}) {
    this.store = store;
    this.options = {
      mode: options.mode ?? 'auto_review',
      minConfidence: options.minConfidence ?? 0.55,
      contradictionThreshold: options.contradictionThreshold ?? 0.6,
    };
  }

  async getMode(): Promise<MemoryMode> {
    const raw = await this.store.getSetting(MODE_SETTING_KEY);
    if (raw === 'manual' || raw === 'auto_review' || raw === 'disabled') return raw;
    return this.options.mode;
  }

  async setMode(mode: MemoryMode): Promise<void> {
    await this.store.setSetting(MODE_SETTING_KEY, mode);
  }

  /** Retrieval for a turn: filtered by scope, then ranked, then budget-capped. */
  async retrieve(params: {
    characterId: string;
    query: string;
    limit?: number;
  }): Promise<RankedMemory[]> {
    if ((await this.getMode()) === 'disabled') return [];
    const query: MemoryQuery = { characterId: params.characterId, query: params.query, limit: params.limit ?? 6 };
    const rows = await this.store.listMemories({ ...query, limit: 200 });
    const ranked = retrieveMemories(params.query, rows, params.limit ?? 6);
    const accessedAt = nowIso();
    for (const entry of ranked) {
      await this.store.updateMemory(entry.memory.id, { lastAccessedAt: accessedAt });
    }
    return ranked;
  }

  /**
   * Evaluate model-proposed candidates. The model's confidence is a hint, not
   * authority: duplicates are merged, contradictions are linked via
   * supersession (never silently overwritten), and the user's mode decides
   * whether anything is stored automatically.
   */
  async processCandidates(params: {
    characterId: string;
    sourceMessageId?: string;
    candidates: MemoryCandidate[];
    /** Explicit user action: store pending items without asking again. */
    approve?: boolean;
  }): Promise<MemoryExtractionOutcome> {
    const mode = await this.getMode();
    const existing = await this.store.listMemories({
      characterId: params.characterId,
      includeInactive: true,
      limit: 500,
    });
    const accepted: MemoryRecord[] = [];
    const pending: ExtractedCandidate[] = [];
    const rejected: Array<{ candidate: MemoryCandidate; reason: string }> = [];

    for (const candidate of params.candidates) {
      const content = candidate.content.trim();
      if (content.length < 3) {
        rejected.push({ candidate, reason: 'too short' });
        continue;
      }
      if (candidate.confidence < this.options.minConfidence) {
        rejected.push({ candidate, reason: 'low confidence' });
        continue;
      }
      if (isEphemeral(content)) {
        rejected.push({ candidate, reason: 'looks ephemeral' });
        continue;
      }
      const duplicate = isDuplicateMemory(content, existing);
      if (duplicate) {
        pending.push({ ...candidate, content, duplicateOf: duplicate.id, reason: 'duplicate' });
        rejected.push({ candidate, reason: `duplicate of ${duplicate.id}` });
        continue;
      }
      const contradiction = findContradiction(content, existing, this.options.contradictionThreshold);

      const evaluable: ExtractedCandidate = { ...candidate, content };
      if (contradiction) {
        evaluable.supersedes = contradiction.id;
      }

      if (mode === 'disabled') {
        rejected.push({ candidate, reason: 'memory disabled by user' });
        continue;
      }
      if (mode === 'manual' && !params.approve) {
        pending.push(evaluable);
        continue;
      }

      const record = this.createRecord(evaluable, params.characterId, params.sourceMessageId);
      if (contradiction) {
        await this.store.updateMemory(contradiction.id, {
          status: 'superseded',
          supersededBy: record.id,
        });
      }
      await this.store.upsertMemory(record);
      existing.push(record);
      accepted.push(record);
    }

    return { accepted, pending, rejected };
  }

  /** Approve a pending candidate from the memory manager UI. */
  async approveCandidate(params: {
    characterId: string;
    candidate: ExtractedCandidate;
    sourceMessageId?: string;
  }): Promise<MemoryRecord> {
    const record = this.createRecord(params.candidate, params.characterId, params.sourceMessageId);
    if (params.candidate.supersedes) {
      await this.store.updateMemory(params.candidate.supersedes, {
        status: 'superseded',
        supersededBy: record.id,
      });
    }
    await this.store.upsertMemory(record);
    return record;
  }

  async list(params: { characterId: string; includeInactive?: boolean }): Promise<MemoryRecord[]> {
    return this.store.listMemories({
      characterId: params.characterId,
      includeInactive: params.includeInactive ?? true,
      limit: 500,
    });
  }

  async update(id: string, patch: Partial<MemoryRecord>): Promise<void> {
    await this.store.updateMemory(id, patch);
  }

  /** Hard delete — a deleted memory must never come back through retrieval. */
  async remove(id: string): Promise<void> {
    await this.store.deleteMemory(id);
  }

  private createRecord(
    candidate: MemoryCandidate,
    characterId: string,
    sourceMessageId?: string,
  ): MemoryRecord {
    const timestamp = nowIso();
    return {
      id: createId('mem'),
      scope: candidate.scope,
      characterId,
      content: candidate.content.trim(),
      category: candidate.category,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sourceMessageId,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }
}

/** Reject throwaway chatter so durable memory stays useful. */
export function isEphemeral(content: string): boolean {
  const text = content.toLowerCase();
  if (text.length < 8) return true;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|cool|nice)\b/.test(text)) return true;
  if (/\b(today|right now|just now|this second)\b/.test(text) && text.length < 40) return true;
  return false;
}

/** Contradiction detection: same topic, different value. */
export function findContradiction(
  candidate: string,
  existing: MemoryRecord[],
  threshold: number,
): MemoryRecord | undefined {
  const candidateNegated = /\b(no longer|not anymore|stopped|quit|used to)\b/i.test(candidate);
  let best: { memory: MemoryRecord; score: number } | undefined;
  for (const memory of existing) {
    if (memory.status !== 'active') continue;
    const overlap = tokenOverlap(candidate, memory.content);
    if (overlap < threshold) continue;
    const memoryNegated = /\b(no longer|not anymore|stopped|quit|used to)\b/i.test(memory.content);
    const negationDiffers = candidateNegated !== memoryNegated;
    const exactish = overlap >= 0.85;
    if (negationDiffers || exactish) {
      if (!best || overlap > best.score) best = { memory, score: overlap };
    }
  }
  return best?.memory;
}
