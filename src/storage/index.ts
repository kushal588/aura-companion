import { DocumentStore } from './store';
import { createIndexedDbKV, createInMemoryKV, type KVAdapter } from './kv';
import { SqliteStore } from './sqliteStore';
import type { Store } from './types';

/**
 * Choose the persistence backend.
 *
 * Desktop (Tauri) → SQLite with FTS5 through native commands.
 * Browser / WebView development → IndexedDB document store.
 * Tests → in-memory store.
 */
export function isTauriRuntime(): boolean {
  return typeof globalThis !== 'undefined' && '__TAURI_INTERNALS__' in globalThis;
}

export function createStore(options: { kv?: KVAdapter; forceDocumentStore?: boolean } = {}): Store {
  if (!options.forceDocumentStore && isTauriRuntime()) {
    return new SqliteStore();
  }
  return new DocumentStore(options.kv ?? createIndexedDbKV());
}

export function createTestStore(): DocumentStore {
  return new DocumentStore(createInMemoryKV());
}

export type { Store } from './types';
export { DocumentStore } from './store';
export { SqliteStore } from './sqliteStore';
