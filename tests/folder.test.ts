import { describe, expect, it } from 'vitest';
import {
  BACKUP_DIR,
  BACKUP_FILE,
  CHATS_DIR,
  MANIFEST_FILE,
  readBundleFromFolder,
  readManifest,
  safeFileName,
  writeBundleToFolder,
  type FsDirHandle,
  type FsFileHandle,
} from '../src/storage/folder';
import type { ExportBundle } from '../src/types/entities';

/**
 * In-memory stand-in for the File System Access API. Mirrors the two call
 * shapes the app uses (getFileHandle/getDirectoryHandle/removeEntry/entries)
 * so the folder writer can be exercised without a real browser.
 */
class MemoryFile implements FsFileHandle {
  kind = 'file' as const;
  constructor(
    public name: string,
    public content = '',
  ) {}

  async createWritable() {
    let staged = '';
    return {
      write: async (data: string) => {
        staged = data;
      },
      close: async () => {
        this.content = staged;
      },
    };
  }

  async getFile() {
    const content = this.content;
    return { text: async () => content };
  }
}

class MemoryDir implements FsDirHandle {
  kind = 'directory' as const;
  children = new Map<string, MemoryDir | MemoryFile>();

  constructor(public name: string) {}

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new TypeMismatchError(name);
      return existing;
    }
    if (!options?.create) throw new NotFoundError(name);
    const file = new MemoryFile(name);
    this.children.set(name, file);
    return file;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new TypeMismatchError(name);
      return existing;
    }
    if (!options?.create) throw new NotFoundError(name);
    const dir = new MemoryDir(name);
    this.children.set(name, dir);
    return dir;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    const existing = this.children.get(name);
    if (!existing) throw new NotFoundError(name);
    if (existing.kind === 'directory' && existing.children.size > 0 && !options?.recursive) {
      throw new Error('Directory not empty');
    }
    this.children.delete(name);
  }

  async *entries() {
    for (const entry of this.children) {
      yield entry;
    }
  }
}

class NotFoundError extends Error {
  constructor(name: string) {
    super(`${name} not found`);
    this.name = 'NotFoundError';
  }
}

class TypeMismatchError extends Error {
  constructor(name: string) {
    super(`${name} is the wrong kind`);
    this.name = 'TypeMismatchError';
  }
}

function bundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return {
    schemaVersion: 1,
    exportedAt: '2026-10-27T12:00:00.000Z',
    app: { name: 'AURA', version: '0.1.0' },
    characters: [
      {
        id: 'char-1',
        name: 'Aiko',
        manifestJson: '{}',
        promptText: 'You are Aiko.',
        promptVersion: 1,
        createdAt: '2026-10-27T12:00:00.000Z',
        updatedAt: '2026-10-27T12:00:00.000Z',
      },
    ],
    conversations: [
      {
        id: 'conv-1',
        characterId: 'char-1',
        title: 'First chat: weather & plans',
        createdAt: '2026-10-27T12:00:00.000Z',
        updatedAt: '2026-10-27T12:00:00.000Z',
      },
      { id: 'conv-2', characterId: 'char-1', title: '', createdAt: '', updatedAt: '' },
    ],
    messages: [
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'user',
        modality: 'text',
        bodyText: 'Hello',
        status: 'complete',
        createdAt: '2026-10-27T12:00:00.000Z',
      },
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        role: 'assistant',
        modality: 'text',
        bodyText: 'Hi there',
        status: 'complete',
        createdAt: '2026-10-27T12:00:01.000Z',
      },
      {
        id: 'msg-3',
        conversationId: 'conv-2',
        role: 'user',
        modality: 'text',
        bodyText: 'Second chat',
        status: 'complete',
        createdAt: '2026-10-27T12:00:02.000Z',
      },
    ],
    memories: [],
    settings: [],
    ...overrides,
  };
}

describe('safeFileName', () => {
  it('keeps ids and readable titles and strips unsafe characters', () => {
    expect(safeFileName('First chat: weather & plans', 'conv-1')).toBe(
      'conv-1-First-chat-weather-plans.json',
    );
  });

  it('falls back for empty or hostile titles and never escapes the directory', () => {
    expect(safeFileName('', 'conv-2')).toBe('conv-2-untitled.json');
    expect(safeFileName('../../etc/passwd', 'conv-3')).toBe('conv-3-etcpasswd.json');
    expect(safeFileName('a/b\\c', 'conv-4')).not.toMatch(/[/\\]/);
    expect(safeFileName('x'.repeat(500), 'conv-5').length).toBeLessThan(80);
  });
});

describe('writeBundleToFolder', () => {
  it('writes the manifest, the restorable bundle and a file per conversation', async () => {
    const root = new MemoryDir('root');
    const source = bundle();

    const written = await writeBundleToFolder(root, source);
    expect(written).toBe(2);

    const backupDir = await root.getDirectoryHandle(BACKUP_DIR);
    expect(backupDir.children.has(MANIFEST_FILE)).toBe(true);
    expect(backupDir.children.has(BACKUP_FILE)).toBe(true);

    // Both conversations produced a readable file, and their messages match.
    const chats = await backupDir.getDirectoryHandle(CHATS_DIR);
    expect(chats.children.size).toBe(2);
    const first = JSON.parse(
      await (await chats.getFileHandle('conv-1-First-chat-weather-plans.json')).getFile().then((f) => f.text()),
    );
    expect(first.conversation.id).toBe('conv-1');
    expect(first.messages).toHaveLength(2);
    expect(first.messages[1].bodyText).toBe('Hi there');

    const second = JSON.parse(
      await (await chats.getFileHandle('conv-2-untitled.json')).getFile().then((f) => f.text()),
    );
    expect(second.messages).toHaveLength(1);
  });

  it('round-trips through readBundleFromFolder', async () => {
    const root = new MemoryDir('root');
    const source = bundle();
    await writeBundleToFolder(root, source);

    const restored = await readBundleFromFolder(root);
    expect(restored).not.toBeNull();
    expect(restored?.conversations).toHaveLength(2);
    expect(restored?.messages).toHaveLength(3);
    expect(restored?.characters[0]?.name).toBe('Aiko');
    expect(restored?.schemaVersion).toBe(1);
  });

  it('drops stale chat files when a conversation was deleted', async () => {
    const root = new MemoryDir('root');
    await writeBundleToFolder(root, bundle());

    const trimmed = bundle({ conversations: [bundle().conversations[0]!] });
    await writeBundleToFolder(root, trimmed);

    const backupDir = await root.getDirectoryHandle(BACKUP_DIR);
    const chats = await backupDir.getDirectoryHandle(CHATS_DIR);
    expect(chats.children.size).toBe(1);
    expect(chats.children.has('conv-1-First-chat-weather-plans.json')).toBe(true);
  });

  it('reports counts in the manifest without loading the whole bundle', async () => {
    const root = new MemoryDir('root');
    await writeBundleToFolder(root, bundle());

    const manifest = await readManifest(root);
    expect(manifest?.counts).toEqual({
      characters: 1,
      conversations: 2,
      messages: 3,
      memories: 0,
    });
    expect(manifest?.app.name).toBe('AURA');
  });
});

describe('readBundleFromFolder', () => {
  it('returns null for a folder with no backup', async () => {
    const root = new MemoryDir('root');
    expect(await readBundleFromFolder(root)).toBeNull();
  });

  it('rejects a backup that is not a valid bundle', async () => {
    const root = new MemoryDir('root');
    const dir = await root.getDirectoryHandle(BACKUP_DIR, { create: true });
    const file = await dir.getFileHandle(BACKUP_FILE, { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify({ nope: true }));
    await writable.close();

    await expect(readBundleFromFolder(root)).rejects.toThrow(/valid AURA backup/);
  });

  it('returns null when the manifest is missing', async () => {
    const root = new MemoryDir('root');
    expect(await readManifest(root)).toBeNull();
  });
});
