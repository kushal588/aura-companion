import { describe, expect, it } from 'vitest';
import { createTestStore } from '../src/storage';
import { MemoryService, findContradiction, isEphemeral } from '../src/memory/MemoryService';
import { isDuplicateMemory, normalizeMemoryContent, retrieveMemories } from '../src/memory/retrieval';
import type { MemoryRecord } from '../src/types/entities';
import type { MemoryCandidate } from '../src/types/turn';

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    content: 'The user is building a local-first AI companion app called AURA',
    category: 'project',
    scope: 'character',
    confidence: 0.85,
    importance: 0.7,
    ...overrides,
  };
}

describe('MemoryService', () => {
  it('saves a durable fact with provenance', async () => {
    const store = createTestStore();
    const service = new MemoryService(store);
    const outcome = await service.processCandidates({
      characterId: 'aiko',
      sourceMessageId: 'msg-1',
      candidates: [candidate()],
    });
    expect(outcome.accepted).toHaveLength(1);
    const stored = await store.listMemories({ characterId: 'aiko' });
    expect(stored[0]?.sourceMessageId).toBe('msg-1');
    expect(stored[0]?.status).toBe('active');
  });

  it('rejects duplicates instead of storing the same fact twice', async () => {
    const store = createTestStore();
    const service = new MemoryService(store);
    await service.processCandidates({ characterId: 'aiko', candidates: [candidate()] });
    const second = await service.processCandidates({ characterId: 'aiko', candidates: [candidate()] });
    expect(second.accepted).toHaveLength(0);
    expect(second.rejected[0]?.reason).toMatch(/duplicate/);
    expect(await store.listMemories({ characterId: 'aiko' })).toHaveLength(1);
  });

  it('links contradictory facts by supersession rather than overwriting', async () => {
    const store = createTestStore();
    const service = new MemoryService(store);
    const first = await service.processCandidates({
      characterId: 'aiko',
      candidates: [candidate({ content: 'The user works at Northwind', confidence: 0.9 })],
    });
    const superseded = first.accepted[0];
    const second = await service.processCandidates({
      characterId: 'aiko',
      candidates: [candidate({ content: 'The user no longer works at Northwind', confidence: 0.9 })],
    });

    const memories = await store.listMemories({ characterId: 'aiko', includeInactive: true });
    const oldRecord = memories.find((memory) => memory.id === superseded?.id);
    expect(second.accepted).toHaveLength(1);
    expect(oldRecord?.status).toBe('superseded');
    expect(oldRecord?.supersededBy).toBe(second.accepted[0]?.id);
  });

  it('drops throwaway chatter and low-confidence guesses', async () => {
    const store = createTestStore();
    const service = new MemoryService(store);
    const outcome = await service.processCandidates({
      characterId: 'aiko',
      candidates: [
        candidate({ content: 'ok' }),
        candidate({ content: 'The user is hungry right now' }),
        candidate({ content: 'The user prefers TypeScript over JavaScript', confidence: 0.2 }),
      ],
    });
    expect(outcome.accepted).toHaveLength(0);
    expect(outcome.rejected).toHaveLength(3);
  });

  it('honours manual mode by holding candidates for review', async () => {
    const store = createTestStore();
    const service = new MemoryService(store);
    await service.setMode('manual');
    const outcome = await service.processCandidates({ characterId: 'aiko', candidates: [candidate()] });
    expect(outcome.accepted).toHaveLength(0);
    expect(outcome.pending).toHaveLength(1);
    const approved = await service.approveCandidate({
      characterId: 'aiko',
      candidate: outcome.pending[0] as (typeof outcome.pending)[number],
    });
    expect(approved.status).toBe('active');
    expect(await store.listMemories({ characterId: 'aiko' })).toHaveLength(1);
  });

  it('stores nothing at all when memory is disabled', async () => {
    const store = createTestStore();
    const service = new MemoryService(store);
    await service.setMode('disabled');
    await service.processCandidates({ characterId: 'aiko', candidates: [candidate()] });
    expect(await store.listMemories({ characterId: 'aiko' })).toHaveLength(0);
    expect(await service.retrieve({ characterId: 'aiko', query: 'project' })).toHaveLength(0);
  });

  it('never retrieves a deleted memory again', async () => {
    const store = createTestStore();
    const service = new MemoryService(store);
    const outcome = await service.processCandidates({ characterId: 'aiko', candidates: [candidate()] });
    const memory = outcome.accepted[0];
    expect(memory).toBeDefined();
    expect(await service.retrieve({ characterId: 'aiko', query: 'building companion app' })).toHaveLength(1);

    await service.remove(memory!.id);
    expect(await service.retrieve({ characterId: 'aiko', query: 'building companion app' })).toHaveLength(0);
  });

  it('does not leak character-scoped memories into another character', async () => {
    const store = createTestStore();
    const service = new MemoryService(store);
    await service.processCandidates({ characterId: 'aiko', candidates: [candidate()] });
    const other = await service.retrieve({ characterId: 'ren', query: 'building companion app' });
    expect(other).toHaveLength(0);
  });

  it('ranks a relevant fact above an irrelevant but important one', async () => {
    const store = createTestStore();
    const service = new MemoryService(store);
    await service.processCandidates({
      characterId: 'aiko',
      candidates: [
        candidate({ content: 'The user keeps a spreadsheet of hiking trails', importance: 0.95 }),
        candidate({ content: 'The user started learning the cello last spring', importance: 0.6 }),
      ],
    });
    const ranked = await service.retrieve({ characterId: 'aiko', query: 'how is the cello practice going' });
    expect(ranked[0]?.memory.content).toMatch(/cello/);
  });
});

describe('memory heuristics', () => {
  it('normalises and deduplicates text', () => {
    expect(normalizeMemoryContent('  My Project: is DONE!! ')).toBe('my project is done');
    const existing: MemoryRecord[] = [
      {
        id: 'm1',
        scope: 'user',
        content: 'My project is done',
        category: 'project',
        confidence: 0.8,
        importance: 0.5,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    expect(isDuplicateMemory('my project is done', existing)?.id).toBe('m1');
  });

  it('detects ephemeral chatter', () => {
    expect(isEphemeral('thanks')).toBe(true);
    expect(isEphemeral('I am hungry right now')).toBe(true);
    expect(isEphemeral('The user works as a marine biologist in Iceland')).toBe(false);
  });

  it('finds contradictions only when the topic overlaps', () => {
    const existing: MemoryRecord[] = [
      {
        id: 'm9',
        scope: 'user',
        content: 'The user works at Northwind',
        category: 'project',
        confidence: 0.9,
        importance: 0.6,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    expect(findContradiction('The user no longer works at Northwind', existing, 0.6)?.id).toBe('m9');
    expect(findContradiction('The user enjoys photography', existing, 0.6)).toBeUndefined();
  });

  it('returns newest important memories when there is no query', () => {
    const records: MemoryRecord[] = [1, 2].map((index) => ({
      id: `m${index}`,
      scope: 'user',
      content: `fact ${index}`,
      category: 'other',
      confidence: 0.8,
      importance: index === 1 ? 0.9 : 0.2,
      status: 'active',
      createdAt: new Date(2026, 0, index).toISOString(),
      updatedAt: new Date(2026, 0, index).toISOString(),
    }));
    expect(retrieveMemories('', records, 1)[0]?.memory.id).toBe('m1');
  });
});
