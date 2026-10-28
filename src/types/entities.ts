import type { Emotion } from './emotion';
import type { MemoryScope } from './emotion';

/**
 * Persisted entities (PLAN §9.2). These mirror the SQLite schema one-to-one so
 * the SQLite store (desktop) and the IndexedDB store (web fallback) can share
 * the same service layer.
 */

export type MessageRole = 'user' | 'assistant' | 'system_event';
export type MessageModality = 'text' | 'live';
export type MessageStatus = 'pending' | 'complete' | 'error' | 'interrupted';

export interface CharacterRecord {
  id: string;
  name: string;
  /** Serialised character manifest (PLAN §4.2). */
  manifestJson: string;
  promptText: string;
  promptVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRecord {
  id: string;
  characterId: string;
  parentConversationId?: string;
  parentMessageId?: string;
  title: string;
  summary?: string;
  /** Temporary chats never persist turns or memories. */
  ephemeral?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  modality: MessageModality;
  bodyText: string;
  status: MessageStatus;
  createdAt: string;
  modelId?: string;
  promptVersion?: number;
  /** JSON blob: segments, emotions, diagnostics reference, live session ids. */
  extraJson?: string;
}

export type MemoryStatus = 'active' | 'disabled' | 'superseded' | 'deleted';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  characterId?: string;
  content: string;
  category: string;
  confidence: number;
  importance: number;
  sourceMessageId?: string;
  status: MemoryStatus;
  /** Set when a newer memory replaces this one (supersession, never silent edit). */
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
}

/** Mood is transient display state; it is never stored as a claim of feeling. */
export interface MoodState {
  emotion: Emotion;
  intensity: number;
  lastChangedAt: number;
  sourceTurnId?: string;
}

export interface SettingsRecord {
  key: string;
  valueJson: string;
}

export interface CharacterSummary {
  character: CharacterRecord;
  conversationCount: number;
  memoryCount: number;
}

/** Export bundle format (PLAN §9.6). API secrets are never included. */
export interface ExportBundle {
  schemaVersion: number;
  exportedAt: string;
  app: { name: string; version: string };
  characters: CharacterRecord[];
  conversations: ConversationRecord[];
  messages: MessageRecord[];
  memories: MemoryRecord[];
  settings: SettingsRecord[];
}

export const EXPORT_SCHEMA_VERSION = 1;
