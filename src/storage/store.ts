import { createInMemoryKV, type KVAdapter } from './kv';
import { searchDocuments } from './lexical';
import type { MemoryQuery, MessageSearchQuery, Store } from './types';
import type {
  CharacterRecord,
  ConversationRecord,
  ExportBundle,
  MemoryRecord,
  MessageRecord,
  SettingsRecord,
} from '../types/entities';
import { EXPORT_SCHEMA_VERSION } from '../types/entities';
import { nowIso } from '../utils/ids';
import { retrieveMemories } from '../memory/retrieval';

const COLLECTIONS = {
  characters: 'characters',
  conversations: 'conversations',
  messages: 'messages',
  memories: 'memories',
  settings: 'settings',
} as const;

/**
 * Document store used for the browser/WebView fallback and for tests.
 *
 * Records are loaded once and written back per mutation. This keeps semantics
 * identical to the SQLite store (same entities, same cascade rules, same search
 * behaviour) without pretending to be a relational engine — the packaged
 * desktop build uses SQLite via Tauri for real scale.
 */
export class DocumentStore implements Store {
  private readonly kv: KVAdapter;
  private loaded = false;

  private characters: CharacterRecord[] = [];
  private conversations: ConversationRecord[] = [];
  private messages: MessageRecord[] = [];
  private memories: MemoryRecord[] = [];
  private settings: SettingsRecord[] = [];

  constructor(kv: KVAdapter = createInMemoryKV()) {
    this.kv = kv;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.characters = await this.kv.read<CharacterRecord>(COLLECTIONS.characters);
    this.conversations = await this.kv.read<ConversationRecord>(COLLECTIONS.conversations);
    this.messages = await this.kv.read<MessageRecord>(COLLECTIONS.messages);
    this.memories = await this.kv.read<MemoryRecord>(COLLECTIONS.memories);
    this.settings = await this.kv.read<SettingsRecord>(COLLECTIONS.settings);
    this.loaded = true;
  }

  async close(): Promise<void> {
    this.loaded = false;
  }

  private async persist(collection: keyof typeof COLLECTIONS): Promise<void> {
    await this.kv.write(COLLECTIONS[collection], this[collection] as unknown[]);
  }

  async listCharacters(): Promise<CharacterRecord[]> {
    return [...this.characters].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getCharacter(id: string): Promise<CharacterRecord | undefined> {
    return this.characters.find((character) => character.id === id);
  }

  async saveCharacter(record: CharacterRecord): Promise<void> {
    const index = this.characters.findIndex((character) => character.id === record.id);
    if (index >= 0) {
      this.characters[index] = record;
    } else {
      this.characters.push(record);
    }
    await this.persist('characters');
  }

  async deleteCharacter(id: string): Promise<void> {
    const conversationIds = this.conversations
      .filter((conversation) => conversation.characterId === id)
      .map((conversation) => conversation.id);
    this.conversations = this.conversations.filter((conversation) => conversation.characterId !== id);
    this.messages = this.messages.filter((message) => !conversationIds.includes(message.conversationId));
    this.memories = this.memories.filter((memory) => memory.characterId !== id);
    this.characters = this.characters.filter((character) => character.id !== id);
    await Promise.all([
      this.persist('characters'),
      this.persist('conversations'),
      this.persist('messages'),
      this.persist('memories'),
    ]);
  }

  async listConversations(characterId?: string): Promise<ConversationRecord[]> {
    const filtered = characterId
      ? this.conversations.filter((conversation) => conversation.characterId === characterId)
      : this.conversations;
    return [...filtered].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async getConversation(id: string): Promise<ConversationRecord | undefined> {
    return this.conversations.find((conversation) => conversation.id === id);
  }

  async saveConversation(record: ConversationRecord): Promise<void> {
    const index = this.conversations.findIndex((conversation) => conversation.id === record.id);
    if (index >= 0) {
      this.conversations[index] = record;
    } else {
      this.conversations.push(record);
    }
    await this.persist('conversations');
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations = this.conversations.filter((conversation) => conversation.id !== id);
    this.messages = this.messages.filter((message) => message.conversationId !== id);
    // Branch children survive: they keep their history but lose the dangling link.
    this.conversations = this.conversations.map((conversation) =>
      conversation.parentConversationId === id
        ? { ...conversation, parentConversationId: undefined }
        : conversation,
    );
    await Promise.all([this.persist('conversations'), this.persist('messages')]);
  }

  async appendMessage(record: MessageRecord): Promise<void> {
    const index = this.messages.findIndex((message) => message.id === record.id);
    if (index >= 0) {
      this.messages[index] = record;
    } else {
      this.messages.push(record);
    }
    const conversation = await this.getConversation(record.conversationId);
    if (conversation && !conversation.ephemeral) {
      await this.saveConversation({ ...conversation, updatedAt: nowIso() });
    }
    await this.persist('messages');
  }

  async updateMessage(id: string, patch: Partial<MessageRecord>): Promise<void> {
    const index = this.messages.findIndex((message) => message.id === id);
    if (index < 0) return;
    this.messages[index] = { ...(this.messages[index] as MessageRecord), ...patch };
    await this.persist('messages');
  }

  async listMessages(conversationId: string, limit = 500): Promise<MessageRecord[]> {
    return this.messages
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(-limit);
  }

  async searchMessages(query: MessageSearchQuery): Promise<MessageRecord[]> {
    const candidates = query.conversationId
      ? this.messages.filter((message) => message.conversationId === query.conversationId)
      : this.messages;
    const hits = searchDocuments(
      query.query,
      candidates
        .filter((message) => message.bodyText.trim().length > 0)
        .map((message) => ({ id: message.id, text: message.bodyText })),
      query.limit ?? 20,
    );
    const byId = new Map(candidates.map((message) => [message.id, message]));
    return hits
      .map((hit) => byId.get(hit.id))
      .filter((message): message is MessageRecord => Boolean(message));
  }

  async listMemories(query: MemoryQuery): Promise<MemoryRecord[]> {
    return this.memories
      .filter((memory) => matchesQuery(memory, query))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async upsertMemory(record: MemoryRecord): Promise<void> {
    const index = this.memories.findIndex((memory) => memory.id === record.id);
    if (index >= 0) {
      this.memories[index] = record;
    } else {
      this.memories.push(record);
    }
    await this.persist('memories');
  }

  async updateMemory(id: string, patch: Partial<MemoryRecord>): Promise<void> {
    const index = this.memories.findIndex((memory) => memory.id === id);
    if (index < 0) return;
    this.memories[index] = { ...(this.memories[index] as MemoryRecord), ...patch, updatedAt: nowIso() };
    await this.persist('memories');
  }

  async deleteMemory(id: string): Promise<void> {
    // Hard delete: a removed memory must never be retrievable again (PLAN §14.3).
    this.memories = this.memories.filter((memory) => memory.id !== id);
    await this.persist('memories');
  }

  async searchMemories(query: MemoryQuery): Promise<MemoryRecord[]> {
    const candidates = this.memories.filter((memory) => matchesQuery(memory, query));
    const limit = query.limit ?? 6;
    if (!query.query) {
      return candidates
        .sort((a, b) => b.importance - a.importance)
        .slice(0, limit);
    }
    return retrieveMemories(query.query, candidates, limit).map((ranked) => ranked.memory);
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.settings.find((setting) => setting.key === key)?.valueJson;
  }

  async setSetting(key: string, valueJson: string): Promise<void> {
    const index = this.settings.findIndex((setting) => setting.key === key);
    if (index >= 0) {
      this.settings[index] = { key, valueJson };
    } else {
      this.settings.push({ key, valueJson });
    }
    await this.persist('settings');
  }

  async allSettings(): Promise<SettingsRecord[]> {
    return [...this.settings];
  }

  async exportAll(): Promise<ExportBundle> {
    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: nowIso(),
      app: { name: 'AURA', version: '0.1.0' },
      characters: [...this.characters],
      conversations: [...this.conversations],
      messages: [...this.messages],
      memories: [...this.memories],
      settings: this.settings.filter((setting) => !setting.key.includes('secret')),
    };
  }

  async importAll(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<void> {
    if (mode === 'replace') {
      this.characters = [];
      this.conversations = [];
      this.messages = [];
      this.memories = [];
    }
    mergeById(this.characters, bundle.characters);
    mergeById(this.conversations, bundle.conversations);
    mergeById(this.messages, bundle.messages);
    mergeById(this.memories, bundle.memories);
    mergeById(this.settings, bundle.settings, 'key');
    await Promise.all([
      this.persist('characters'),
      this.persist('conversations'),
      this.persist('messages'),
      this.persist('memories'),
      this.persist('settings'),
    ]);
  }

  async purgeAll(): Promise<void> {
    this.characters = [];
    this.conversations = [];
    this.messages = [];
    this.memories = [];
    this.settings = [];
    await this.kv.clear();
  }
}

function matchesQuery(memory: MemoryRecord, query: MemoryQuery): boolean {
  if (!query.includeInactive && memory.status !== 'active') return false;
  if (query.scope && memory.scope !== query.scope) return false;
  if (query.characterId) {
    // Character-scoped memories only apply to their character; user-scoped
    // memories apply everywhere unless a different character owns them.
    if (memory.scope === 'character' && memory.characterId !== query.characterId) return false;
    if (memory.scope === 'user' && memory.characterId && memory.characterId !== query.characterId) {
      return false;
    }
  }
  return true;
}

function mergeById<T>(target: T[], incoming: T[], key = 'id'): void {
  const readKey = (record: T): unknown => (record as Record<string, unknown>)[key];
  for (const record of incoming) {
    const index = target.findIndex((existing) => readKey(existing) === readKey(record));
    if (index >= 0) {
      target[index] = record;
    } else {
      target.push(record);
    }
  }
}
