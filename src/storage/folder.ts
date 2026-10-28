/**
 * Local folder backup (browser File System Access API).
 *
 * The user picks a directory once; the app then writes every durable record
 * into it as plain JSON so chats survive a browser profile wipe, can be copied
 * to a USB stick, or read with any text editor. Nothing here talks to a
 * network — the folder is always on the user's own machine.
 *
 * Layout inside the directory the user picked:
 *
 *   <picked folder>/aura-backup/
 *     manifest.json      small metadata file (when it was written, counts)
 *     backup.json        the full ExportBundle — single source of restore
 *     chats/<id>-<slug>.json   one readable file per conversation
 *
 * `backup.json` is what restore reads, so a partial write of the readable
 * per-chat files can never corrupt a restore.
 */

import type { ExportBundle } from '../types/entities';

export const BACKUP_DIR = 'aura-backup';
export const BACKUP_FILE = 'backup.json';
export const MANIFEST_FILE = 'manifest.json';
export const CHATS_DIR = 'chats';

/** Minimal structural types — avoids depending on a particular lib.dom version. */
export interface FsFileHandle {
  kind: 'file';
  name: string;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
  getFile(): Promise<{ text(): Promise<string> }>;
}

export interface FsDirHandle {
  kind: 'directory';
  name: string;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries?(): AsyncIterableIterator<[string, FsDirHandle | FsFileHandle]>;
}

interface WindowWithPicker {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
    id?: string;
    startIn?: string;
  }) => Promise<FsDirHandle>;
}

export interface FolderManifest {
  schemaVersion: number;
  app: { name: string; version: string };
  savedAt: string;
  counts: {
    characters: number;
    conversations: number;
    messages: number;
    memories: number;
  };
}

/** True when this browser can pick and write a directory. */
export function isFolderAccessSupported(): boolean {
  const withPicker = globalThis as unknown as WindowWithPicker;
  return typeof withPicker.showDirectoryPicker === 'function';
}

/** Prompt the user for a directory. Must be called from a user gesture. */
export async function pickFolder(): Promise<FsDirHandle> {
  const withPicker = globalThis as unknown as WindowWithPicker;
  const picker = withPicker.showDirectoryPicker;
  if (!picker) throw new Error('This browser does not support folder access.');
  const handle = await picker({ mode: 'readwrite', id: 'aura-backup', startIn: 'documents' });
  await ensureWritePermission(handle);
  return handle;
}

/** Re-grant write access to a previously picked folder (needs a user gesture). */
export async function ensureWritePermission(handle: FsDirHandle): Promise<boolean> {
  if (!handle.requestPermission) return true;
  const current = handle.queryPermission
    ? await handle.queryPermission({ mode: 'readwrite' })
    : 'prompt';
  if (current === 'granted') return true;
  const next = await handle.requestPermission({ mode: 'readwrite' });
  return next === 'granted';
}

export function canWrite(handle: FsDirHandle): Promise<boolean> | boolean {
  if (!handle.queryPermission) return true;
  return handle.queryPermission({ mode: 'readwrite' }).then((state) => state === 'granted');
}

async function rootDir(handle: FsDirHandle): Promise<FsDirHandle> {
  return handle.getDirectoryHandle(BACKUP_DIR, { create: true });
}

/** Human-readable, filesystem-safe suffix for a conversation file name. */
export function safeFileName(title: string, id: string): string {
  const slug = [...(title || 'untitled')]
    .map((character) =>
      /[A-Za-z0-9 _-]/.test(character) ? (character === ' ' ? '-' : character) : '',
    )
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${id}-${slug || 'untitled'}.json`;
}

interface ConversationSlice {
  id: string;
  title: string;
}

/**
 * Write the whole bundle to the folder. Writes `backup.json` last so a restore
 * always sees either the previous complete backup or the new one.
 */
export async function writeBundleToFolder(
  handle: FsDirHandle,
  bundle: ExportBundle,
): Promise<number> {
  const dir = await rootDir(handle);

  // Per-conversation readable files. Rebuilt from scratch so deleted chats do
  // not linger as stale files.
  try {
    const chatsDir = await dir.getDirectoryHandle(CHATS_DIR, { create: true });
    await clearDirectory(chatsDir);
    const messagesByConversation = new Map<string, unknown[]>();
    for (const message of bundle.messages) {
      const list = messagesByConversation.get(message.conversationId) ?? [];
      list.push(message);
      messagesByConversation.set(message.conversationId, list);
    }
    const conversations = bundle.conversations as ConversationSlice[];
    for (const conversation of conversations) {
      const file = await chatsDir.getFileHandle(
        safeFileName(conversation.title, conversation.id),
        { create: true },
      );
      const writable = await file.createWritable();
      await writable.write(
        JSON.stringify(
          {
            conversation,
            messages: messagesByConversation.get(conversation.id) ?? [],
          },
          null,
          2,
        ),
      );
      await writable.close();
    }
  } catch {
    // The readable per-chat files are a convenience; failure must not fail the backup.
  }

  const manifest: FolderManifest = {
    schemaVersion: bundle.schemaVersion,
    app: bundle.app,
    savedAt: bundle.exportedAt,
    counts: {
      characters: bundle.characters.length,
      conversations: bundle.conversations.length,
      messages: bundle.messages.length,
      memories: bundle.memories.length,
    },
  };
  await writeJson(dir, MANIFEST_FILE, manifest);
  await writeJson(dir, BACKUP_FILE, bundle);

  return bundle.conversations.length;
}

async function writeJson(dir: FsDirHandle, name: string, value: unknown): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(value, null, 2));
  await writable.close();
}

/** Remove every child of a directory (used to rebuild the readable chat files). */
async function clearDirectory(dir: FsDirHandle): Promise<void> {
  if (typeof dir.entries !== 'function') return;
  const names: string[] = [];
  for await (const [name] of dir.entries()) {
    names.push(name);
  }
  for (const name of names) {
    await dir.removeEntry(name, { recursive: true }).catch(() => undefined);
  }
}

/** Read a previously written backup. Returns null when none exists. */
export async function readBundleFromFolder(handle: FsDirHandle): Promise<ExportBundle | null> {
  let dir: FsDirHandle;
  try {
    dir = await handle.getDirectoryHandle(BACKUP_DIR);
  } catch {
    return null;
  }
  let file: FsFileHandle;
  try {
    file = await dir.getFileHandle(BACKUP_FILE);
  } catch {
    return null;
  }
  const text = await (await file.getFile()).text();
  const parsed = JSON.parse(text) as ExportBundle;
  if (!parsed || !Array.isArray(parsed.conversations)) {
    throw new Error('That folder does not contain a valid AURA backup.');
  }
  return parsed;
}

/** Read the manifest (cheap status display without loading the whole bundle). */
export async function readManifest(handle: FsDirHandle): Promise<FolderManifest | null> {
  try {
    const dir = await handle.getDirectoryHandle(BACKUP_DIR);
    const file = await dir.getFileHandle(MANIFEST_FILE);
    return JSON.parse(await (await file.getFile()).text()) as FolderManifest;
  } catch {
    return null;
  }
}

/**
 * The directory handle itself is persisted in IndexedDB so the link survives a
 * reload. Access must still be re-granted by the browser after a reload, which
 * is why `ensureWritePermission` exists.
 */
const HANDLE_DB = 'aura-folder';
const HANDLE_STORE = 'handle';
const HANDLE_KEY = 'root';

function openHandleDb(): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB as IDBFactory | undefined;
  if (!factory) return Promise.reject(new Error('IndexedDB unavailable'));
  return new Promise((resolve, reject) => {
    const request = factory.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

export async function saveHandle(handle: FsDirHandle): Promise<void> {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(HANDLE_STORE, 'readwrite');
    transaction.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Handle save failed'));
  });
  db.close();
}

export async function loadHandle(): Promise<FsDirHandle | null> {
  try {
    const db = await openHandleDb();
    const value = await new Promise<FsDirHandle | undefined>((resolve, reject) => {
      const transaction = db.transaction(HANDLE_STORE, 'readonly');
      const request = transaction.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      request.onsuccess = () => resolve(request.result as FsDirHandle | undefined);
      request.onerror = () => reject(request.error ?? new Error('Handle read failed'));
    });
    db.close();
    return value ?? null;
  } catch {
    return null;
  }
}

export async function clearHandle(): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(HANDLE_STORE, 'readwrite');
      transaction.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Handle clear failed'));
    });
    db.close();
  } catch {
    // Nothing to clear.
  }
}
