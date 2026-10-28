import { describe, expect, it } from 'vitest';
import { DocumentStore, createTestStore } from '../src/storage';
import { createInMemoryKV } from '../src/storage/kv';
import { searchDocuments, reciprocalRankFusion, tokenize } from '../src/storage/lexical';
import type { ConversationRecord, MemoryRecord, MessageRecord } from '../src/types/entities';
import { EXPORT_SCHEMA_VERSION } from '../src/types/entities';
import { LATEST_SCHEMA_VERSION, migrationSql } from '../src/storage/sqlDdl';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/app/settings';

function conversation(id: string, characterId = 'c1'): ConversationRecord {
  return {
    id,
    characterId,
    title: `Chat ${id}`,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
}

function message(id: string, conversationId: string, bodyText: string): MessageRecord {
  return {
    id,
    conversationId,
    role: 'user',
    modality: 'text',
    bodyText,
    status: 'complete',
    createdAt: `2026-03-01T00:00:0${id.length}.000Z`,
  };
}

describe('DocumentStore', () => {
  it('appends and orders messages, then cascades on delete', async () => {
    const store = createTestStore();
    await store.saveConversation(conversation('conv-1'));
    await store.appendMessage(message('m1', 'conv-1', 'first'));
    await store.appendMessage(message('m2', 'conv-1', 'second'));

    const messages = await store.listMessages('conv-1');
    expect(messages.map((entry) => entry.bodyText)).toEqual(['first', 'second']);

    await store.deleteConversation('conv-1');
    expect(await store.listMessages('conv-1')).toHaveLength(0);
    expect(await store.getConversation('conv-1')).toBeUndefined();
  });

  it('keeps branch children when their parent chat is deleted', async () => {
    const store = createTestStore();
    await store.saveConversation(conversation('parent'));
    await store.saveConversation({ ...conversation('branch'), parentConversationId: 'parent' });
    await store.deleteConversation('parent');

    const branch = await store.getConversation('branch');
    expect(branch).toBeDefined();
    expect(branch?.parentConversationId).toBeUndefined();
  });

  it('searches messages and filters by conversation', async () => {
    const store = createTestStore();
    await store.saveConversation(conversation('conv-a'));
    await store.saveConversation(conversation('conv-b'));
    await store.appendMessage(message('m1', 'conv-a', 'I finished my project yesterday'));
    await store.appendMessage(message('m2', 'conv-b', 'The weather is nice today'));

    const hits = await store.searchMessages({ query: 'finished project' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.conversationId).toBe('conv-a');
    const scoped = await store.searchMessages({ query: 'weather', conversationId: 'conv-a' });
    expect(scoped).toHaveLength(0);
  });

  it('filters memories by scope, character and status', async () => {
    const store = createTestStore();
    const base: MemoryRecord = {
      id: 'mem-1',
      scope: 'character',
      characterId: 'aiko',
      content: 'Loves hiking in the rain',
      category: 'preference',
      confidence: 0.8,
      importance: 0.5,
      status: 'active',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    };
    await store.upsertMemory(base);
    await store.upsertMemory({ ...base, id: 'mem-2', characterId: 'ren' });
    await store.upsertMemory({ ...base, id: 'mem-3', status: 'disabled' });

    const aiko = await store.listMemories({ characterId: 'aiko' });
    expect(aiko.map((memory) => memory.id)).toEqual(['mem-1']);
    const all = await store.listMemories({ characterId: 'aiko', includeInactive: true });
    expect(all).toHaveLength(2);
  });

  it('round-trips an export and import without losing data', async () => {
    const store = createTestStore();
    await store.saveConversation(conversation('conv-1'));
    await store.appendMessage(message('m1', 'conv-1', 'persist me'));
    await store.setSetting('ui.theme', JSON.stringify('dark'));

    const bundle = await store.exportAll();
    expect(bundle.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(bundle.messages).toHaveLength(1);
    expect(JSON.stringify(bundle)).not.toMatch(/AQ\./);

    const target = new DocumentStore(createInMemoryKV());
    await target.importAll(JSON.parse(JSON.stringify(bundle)), 'replace');
    expect(await target.listMessages('conv-1')).toHaveLength(1);
    expect(await target.getSetting('ui.theme')).toBe(JSON.stringify('dark'));
  });

  it('drops everything on purge', async () => {
    const store = createTestStore();
    await store.saveConversation(conversation('conv-1'));
    await store.purgeAll();
    expect(await store.listConversations()).toHaveLength(0);
  });
});

describe('lexical search', () => {
  it('ranks exact topical matches highest and ignores stop words', () => {
    expect(tokenize('The quick brown fox and the lazy dog')).toEqual(['quick', 'brown', 'fox', 'lazy', 'dog']);
    const hits = searchDocuments('cello practice', [
      { id: 'a', text: 'The user started learning the cello last spring' },
      { id: 'b', text: 'The user is a marine biologist' },
      { id: 'c', text: 'Cello practice happens on Tuesdays and cello lessons are weekly' },
    ]);
    expect(hits[0]?.id).toBe('c');
    expect(hits.map((hit) => hit.id)).not.toContain('b');
  });

  it('fuses two ranked lists', () => {
    const fused = reciprocalRankFusion([
      [{ id: 'a', score: 3 }, { id: 'b', score: 1 }],
      [{ id: 'b', score: 2 }, { id: 'a', score: 1 }],
    ]);
    expect(fused).toHaveLength(2);
    expect(fused.every((entry) => entry.score > 0)).toBe(true);
  });
});

describe('SQLite schema', () => {
  it('declares every table the store depends on and never stores secrets', () => {
    const sql = migrationSql().join('\n');
    for (const table of ['characters', 'conversations', 'messages', 'memories', 'settings']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('messages_fts');
    expect(sql).toContain('memories_fts');
    expect(sql).toContain('CREATE TRIGGER');
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    // No column may hold an API key.
    expect(sql).not.toMatch(/api_?key/i);
  });
});

describe('settings sanitisation', () => {
  it('clamps out-of-range values and keeps defaults for junk', () => {
    const sanitized = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      temperature: 99,
      maxOutputTokens: Number.NaN,
      expressiveness: -5,
      liveChunkMs: 5000,
      textModelId: '   ',
    });
    expect(sanitized.temperature).toBe(2);
    expect(sanitized.maxOutputTokens).toBe(2048);
    expect(sanitized.expressiveness).toBe(0.2);
    expect(sanitized.liveChunkMs).toBe(100);
    expect(sanitized.textModelId).toBe(DEFAULT_SETTINGS.textModelId);
  });
});
