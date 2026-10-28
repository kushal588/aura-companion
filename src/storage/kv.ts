/**
 * Key/value backends for the local store.
 *
 * The desktop build uses SQLite through Tauri commands (`sqliteStore.ts`). The
 * browser/development fallback uses IndexedDB, and tests use the in-memory
 * implementation. All three expose identical document semantics so the service
 * layer never branches on platform.
 */

export interface KVAdapter {
  /** Read every record of a collection. */
  read<T>(collection: string): Promise<T[]>;
  /** Replace every record of a collection atomically. */
  write<T>(collection: string, records: T[]): Promise<void>;
  /** Drop all collections (used by "delete all data"). */
  clear(): Promise<void>;
}

export function createInMemoryKV(): KVAdapter {
  const collections = new Map<string, unknown[]>();
  return {
    async read<T>(collection: string): Promise<T[]> {
      return [...(collections.get(collection) ?? [])] as T[];
    },
    async write<T>(collection: string, records: T[]): Promise<void> {
      collections.set(collection, [...records]);
    },
    async clear(): Promise<void> {
      collections.clear();
    },
  };
}

const DB_NAME = 'aura';
const DB_VERSION = 1;
const STORE_NAME = 'collections';

/**
 * IndexedDB adapter. One object store holds a record array per collection; this
 * keeps the fallback simple and transactional. It is a development/WebView
 * convenience path — the packaged desktop app stores data in SQLite.
 */
export function createIndexedDbKV(indexedDb?: IDBFactory): KVAdapter {
  const factory = indexedDb ?? (globalThis.indexedDB as IDBFactory | undefined);
  if (!factory) {
    return createInMemoryKV();
  }

  let dbPromise: Promise<IDBDatabase> | undefined;

  const open = (): Promise<IDBDatabase> => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return dbPromise;
  };

  const withStore = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  };

  return {
    async read<T>(collection: string): Promise<T[]> {
      const value = await withStore<T[] | undefined>('readonly', (store) => store.get(collection));
      return value ?? [];
    },
    async write<T>(collection: string, records: T[]): Promise<void> {
      await withStore('readwrite', (store) => store.put(records, collection));
    },
    async clear(): Promise<void> {
      await withStore('readwrite', (store) => store.clear());
    },
  };
}
