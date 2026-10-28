import type { MemoryScope } from '../types/emotion';
import type { MemoryRecord } from '../types/entities';
import { searchDocuments, type SearchHit } from '../storage/lexical';

/**
 * Retrieval and ranking (PLAN §9.4).
 *
 * Step 1 (scope/status filtering) happens in the store query; this module does
 * the lexical match and the re-rank. Embedding search is deliberately absent in
 * v1 — `reciprocalRankFusion` is ready for it when a provider is configured.
 */

export interface MemoryQuery {
  characterId?: string;
  scope?: MemoryScope;
  query?: string;
  limit?: number;
  includeInactive?: boolean;
}

export interface RankedMemory {
  memory: MemoryRecord;
  score: number;
  matchedTerms: string[];
}

export interface RankOptions {
  now?: number;
  /** Halving time for the recency component, in days. */
  halfLifeDays?: number;
}

/** Re-rank hits by relevance, recency, confidence, importance (PLAN §9.4 step 4). */
export function rankMemories(
  hits: SearchHit[],
  memories: MemoryRecord[],
  options: RankOptions = {},
): RankedMemory[] {
  const now = options.now ?? Date.now();
  const halfLifeMs = (options.halfLifeDays ?? 120) * 24 * 60 * 60 * 1000;
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const ranked: RankedMemory[] = [];

  for (const hit of hits) {
    const memory = byId.get(hit.id);
    if (!memory) continue;
    const ageMs = Math.max(0, now - Date.parse(memory.createdAt || '1970-01-01T00:00:00Z'));
    const recency = Math.pow(0.5, ageMs / halfLifeMs);
    const reliability = 0.6 + 0.4 * memory.confidence;
    const importance = 0.7 + 0.3 * memory.importance;
    ranked.push({
      memory,
      score: hit.score * recency * reliability * importance,
      matchedTerms: hit.matchedTerms,
    });
  }

  return ranked.sort((a, b) => b.score - a.score);
}

/** Lexical retrieval over an already scope-filtered candidate set. */
export function retrieveMemories(
  query: string,
  candidates: MemoryRecord[],
  limit = 6,
  options: RankOptions = {},
): RankedMemory[] {
  if (candidates.length === 0) return [];
  if (!query.trim()) {
    // No query text (e.g. first turn): fall back to newest important memories.
    return [...candidates]
      .sort((a, b) => b.importance - a.importance || Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map((memory) => ({ memory, score: memory.importance, matchedTerms: [] }));
  }
  const hits = searchDocuments(
    query,
    candidates.map((memory) => ({
      id: memory.id,
      text: memory.content,
      weight: 0.5 + memory.importance,
    })),
    limit * 3,
  );
  return rankMemories(hits, candidates, options).slice(0, limit);
}

/** Normalised text used for duplicate detection. */
export function normalizeMemoryContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Duplicate detection (PLAN §9.3). Exact-normalised matches and high token
 * overlap both count, so "I finished my project" and "My project is finished"
 * do not both become durable memories.
 */
export function isDuplicateMemory(
  candidate: string,
  existing: MemoryRecord[],
  threshold = 0.72,
): MemoryRecord | undefined {
  const normalized = normalizeMemoryContent(candidate);
  if (!normalized) return undefined;
  const candidateTokens = new Set(normalized.split(' '));

  for (const memory of existing) {
    if (memory.status === 'deleted') continue;
    const other = normalizeMemoryContent(memory.content);
    if (!other) continue;
    if (other === normalized) return memory;
    const otherTokens = new Set(other.split(' '));
    const intersection = [...candidateTokens].filter((token) => otherTokens.has(token)).length;
    const union = new Set([...candidateTokens, ...otherTokens]).size;
    if (union > 0 && intersection / union >= threshold) return memory;
  }
  return undefined;
}

/** Intersection/union similarity for contradiction checks. */
export function tokenOverlap(a: string, b: string): number {
  const first = new Set(normalizeMemoryContent(a).split(' ').filter(Boolean));
  const second = new Set(normalizeMemoryContent(b).split(' ').filter(Boolean));
  const union = new Set([...first, ...second]).size;
  if (union === 0) return 0;
  const intersection = [...first].filter((token) => second.has(token)).length;
  return intersection / union;
}
