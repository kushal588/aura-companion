import { invoke } from '@tauri-apps/api/core';
import type {
  CharacterRecord,
  ConversationRecord,
  ExportBundle,
  MemoryRecord,
  MessageRecord,
  SettingsRecord,
} from '../types/entities';
import type { MemoryQuery, MessageSearchQuery, Store } from './types';

/**
 * SQLite store for the packaged desktop app (PLAN §10.1).
 *
 * Every call maps to a *semantic* native command — the renderer can never send
 * raw SQL, so a compromised UI cannot read or drop arbitrary tables. Secrets are
 * not part of this surface: they live in the OS credential store.
 *
 * SQLite FTS5 powers `searchMessages`/`searchMemories`; results are re-ranked in
 * TypeScript so ranking behaves identically across platforms.
 */

const command = <T>(name: string, args?: Record<string, unknown>): Promise<T> =>
  invoke<T>(name, args);

export class SqliteStore implements Store {
  private ready = false;

  async init(): Promise<void> {
    if (this.ready) return;
    await command('db_migrate');
    this.ready = true;
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  listCharacters(): Promise<CharacterRecord[]> {
    return command('characters_list');
  }

  getCharacter(id: string): Promise<CharacterRecord | undefined> {
    return command('characters_get', { id });
  }

  saveCharacter(record: CharacterRecord): Promise<void> {
    return command('characters_save', { record });
  }

  deleteCharacter(id: string): Promise<void> {
    return command('characters_delete', { id });
  }

  listConversations(characterId?: string): Promise<ConversationRecord[]> {
    return command('conversations_list', { characterId: characterId ?? null });
  }

  getConversation(id: string): Promise<ConversationRecord | undefined> {
    return command('conversations_get', { id });
  }

  saveConversation(record: ConversationRecord): Promise<void> {
    return command('conversations_save', { record });
  }

  deleteConversation(id: string): Promise<void> {
    return command('conversations_delete', { id });
  }

  appendMessage(record: MessageRecord): Promise<void> {
    return command('messages_append', { record });
  }

  updateMessage(id: string, patch: Partial<MessageRecord>): Promise<void> {
    return command('messages_update', { id, patch });
  }

  listMessages(conversationId: string, limit = 500): Promise<MessageRecord[]> {
    return command('messages_list', { conversationId, limit });
  }

  searchMessages(query: MessageSearchQuery): Promise<MessageRecord[]> {
    return command('messages_search', {
      query: query.query,
      conversationId: query.conversationId ?? null,
      limit: query.limit ?? 20,
    });
  }

  listMemories(query: MemoryQuery): Promise<MemoryRecord[]> {
    return command('memories_list', { query: serializeQuery(query) });
  }

  upsertMemory(record: MemoryRecord): Promise<void> {
    return command('memories_upsert', { record });
  }

  updateMemory(id: string, patch: Partial<MemoryRecord>): Promise<void> {
    return command('memories_update', { id, patch });
  }

  deleteMemory(id: string): Promise<void> {
    return command('memories_delete', { id });
  }

  searchMemories(query: MemoryQuery): Promise<MemoryRecord[]> {
    return command('memories_search', { query: serializeQuery(query) });
  }

  async getSetting(key: string): Promise<string | undefined> {
    const value = await command<string | null>('settings_get', { key });
    return value ?? undefined;
  }

  setSetting(key: string, valueJson: string): Promise<void> {
    return command('settings_set', { key, valueJson });
  }

  allSettings(): Promise<SettingsRecord[]> {
    return command('settings_all');
  }

  exportAll(): Promise<ExportBundle> {
    return command('export_bundle');
  }

  importAll(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<void> {
    return command('import_bundle', { bundle, mode });
  }

  purgeAll(): Promise<void> {
    return command('db_purge');
  }
}

function serializeQuery(query: MemoryQuery): Record<string, unknown> {
  return {
    characterId: query.characterId ?? null,
    scope: query.scope ?? null,
    query: query.query ?? null,
    limit: query.limit ?? 6,
    includeInactive: query.includeInactive ?? false,
  };
}
