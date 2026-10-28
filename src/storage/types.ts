import type {
  CharacterRecord,
  ConversationRecord,
  ExportBundle,
  MemoryRecord,
  MessageRecord,
  SettingsRecord,
} from '../types/entities';
import type { MemoryScope } from '../types/emotion';

/** Query shape for memory retrieval (PLAN §9.4). */
export interface MemoryQuery {
  characterId?: string;
  scope?: MemoryScope;
  query?: string;
  limit?: number;
  /** Include disabled/superseded rows (memory manager UI only, never prompts). */
  includeInactive?: boolean;
}

export interface MessageSearchQuery {
  query: string;
  conversationId?: string;
  limit?: number;
}

/**
 * Persistence contract.
 *
 * Two implementations exist: SQLite through Tauri (packaged desktop app) and a
 * document store (browser development / tests). Durable entities never go
 * through `localStorage` (PLAN §10.3).
 */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  listCharacters(): Promise<CharacterRecord[]>;
  getCharacter(id: string): Promise<CharacterRecord | undefined>;
  saveCharacter(record: CharacterRecord): Promise<void>;
  deleteCharacter(id: string): Promise<void>;

  listConversations(characterId?: string): Promise<ConversationRecord[]>;
  getConversation(id: string): Promise<ConversationRecord | undefined>;
  saveConversation(record: ConversationRecord): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  appendMessage(record: MessageRecord): Promise<void>;
  updateMessage(id: string, patch: Partial<MessageRecord>): Promise<void>;
  listMessages(conversationId: string, limit?: number): Promise<MessageRecord[]>;
  searchMessages(query: MessageSearchQuery): Promise<MessageRecord[]>;

  listMemories(query: MemoryQuery): Promise<MemoryRecord[]>;
  upsertMemory(record: MemoryRecord): Promise<void>;
  updateMemory(id: string, patch: Partial<MemoryRecord>): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  searchMemories(query: MemoryQuery): Promise<MemoryRecord[]>;

  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, valueJson: string): Promise<void>;
  allSettings(): Promise<SettingsRecord[]>;

  exportAll(): Promise<ExportBundle>;
  importAll(bundle: ExportBundle, mode: 'merge' | 'replace'): Promise<void>;
  purgeAll(): Promise<void>;
}
