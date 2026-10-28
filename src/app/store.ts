import { create } from 'zustand';
import { createStore as createPersistenceStore, type Store } from '../storage';
import {
  createCredentialStore,
  describeCredentialLocation,
  type CredentialStatus,
  type CredentialStore,
} from './credentials';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AppSettings } from './settings';
import { AuraEngine } from './engine';
import type {
  CharacterRecord,
  ConversationRecord,
  MemoryRecord,
  MessageRecord,
  MoodState,
} from '../types/entities';
import type { StructuredTurn, TurnDiagnostics } from '../types/turn';
import type { LiveStatus } from '../types/live';
import type { QualityTier } from '../avatar/AvatarStage';
import type { VrmAssetSummary } from '../avatar/VRMAssetManager';
import { createId, nowIso } from '../utils/ids';
import {
  canWrite,
  clearHandle,
  ensureWritePermission,
  isFolderAccessSupported,
  loadHandle,
  pickFolder,
  readBundleFromFolder,
  readManifest,
  saveHandle,
  writeBundleToFolder,
  type FsDirHandle,
} from '../storage/folder';
import { describeProviderError } from '../utils/retry';
import { titleFromFirstMessage } from '../utils/text';
import { DEFAULT_CHARACTER_PROMPT, characterFromInput, manifestFor } from '../character/characterSchema';

/**
 * App store (PLAN §10.3).
 *
 * Partitions: character, conversation, memory, audio/live, avatar, settings, UI.
 * Durable entities always go through the store (SQLite/IndexedDB); the engine is
 * a module singleton because it owns GPU and audio resources that must not be
 * duplicated by React re-renders.
 */

export interface Caption {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
}

export interface AuraState {
  ready: boolean;
  fatalError?: string;
  status: string;

  settings: AppSettings;
  credentialStatus: CredentialStatus;

  characters: CharacterRecord[];
  activeCharacterId?: string;
  conversations: ConversationRecord[];
  activeConversationId?: string;
  messages: MessageRecord[];
  memories: MemoryRecord[];

  mood: MoodState;
  speaking: boolean;
  live: LiveStatus;
  captions: Caption[];
  diagnostics: TurnDiagnostics[];
  diagnosticsJson?: string;
  quality: QualityTier;
  qualityReason: string;
  assetSummary?: VrmAssetSummary;
  showHistory: boolean;
  showSettings: boolean;
  showMemory: boolean;
  showCharacter: boolean;
  onboardingStep: number | 'done';

  // actions
  init: () => Promise<void>;
  attachCanvas: (canvas: HTMLCanvasElement) => void;
  sendMessage: (text: string) => Promise<void>;
  interrupt: () => void;
  startLive: () => Promise<void>;
  stopLive: () => Promise<void>;
  sendLiveText: (text: string) => void;
  setLiveMuted: (muted: boolean) => void;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  saveActiveCharacter: (patch: Partial<CharacterRecord>) => Promise<void>;
  createCharacter: (input: { name: string; prompt: string }) => Promise<void>;
  selectCharacter: (id: string) => Promise<void>;
  newConversation: (options?: { ephemeral?: boolean }) => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  branchConversation: (messageId: string) => Promise<void>;
  importVrm: (file: File) => Promise<void>;
  importVrma: (file: File) => Promise<void>;
  useProceduralAvatar: () => Promise<void>;
  reloadMemories: () => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  setMemoryStatus: (id: string, status: MemoryRecord['status']) => Promise<void>;
  exportData: () => Promise<string>;
  importData: (json: string, mode: 'merge' | 'replace') => Promise<void>;
  purgeAll: () => Promise<void>;

  // Local folder backup (File System Access API).
  folderSupported: boolean;
  folderName?: string;
  folderStatus: 'none' | 'connected' | 'needs-permission' | 'error';
  folderLastSavedAt?: string;
  folderError?: string;
  connectFolder: () => Promise<void>;
  saveToFolder: () => Promise<void>;
  loadFromFolder: () => Promise<void>;
  disconnectFolder: () => Promise<void>;

  setDialog: (dialog: 'history' | 'settings' | 'memory' | 'character', open: boolean) => void;
  setOnboardingStep: (step: number | 'done') => void;
  refreshMessages: () => Promise<void>;
}

interface Services {
  store?: Store;
  credentials?: CredentialStore;
  engine?: AuraEngine;
  folder?: FsDirHandle;
}

const services: Services = {};

const initialLiveStatus: LiveStatus = {
  state: 'idle',
  epoch: 0,
  micMuted: false,
  bufferedMs: 0,
  droppedChunks: 0,
};

export const useAura = create<AuraState>((set, get) => ({
  ready: false,
  status: 'Starting AURA…',
  settings: { ...DEFAULT_SETTINGS },
  credentialStatus: { hasKey: false, location: 'session_memory', ephemeral: true },
  characters: [],
  conversations: [],
  messages: [],
  memories: [],
  mood: { emotion: 'neutral', intensity: 0, lastChangedAt: 0 },
  speaking: false,
  live: initialLiveStatus,
  captions: [],
  diagnostics: [],
  quality: DEFAULT_SETTINGS.quality,
  qualityReason: 'default',
  showHistory: false,
  showSettings: false,
  showMemory: false,
  showCharacter: false,
  onboardingStep: 0,

  folderSupported: isFolderAccessSupported(),
  folderStatus: 'none',

  async init() {
    if (services.store) return;
    const store = createPersistenceStore();
    await store.init();
    services.store = store;

    const credentials = createCredentialStore();
    services.credentials = credentials;
    const settings = await loadSettings(store);
    const credentialStatus = await credentials.status();

    let characters = await store.listCharacters();
    if (characters.length === 0) {
      const character = characterFromInput({ id: createId('char'), name: 'Aiko', prompt: DEFAULT_CHARACTER_PROMPT });
      await store.saveCharacter(character);
      characters = [character];
    }

    const activeCharacterId = characters[0]?.id;
    const conversations = await store.listConversations(activeCharacterId);
    const activeConversationId = conversations[0]?.id;
    const messages = activeConversationId ? await store.listMessages(activeConversationId) : [];
    const memories = activeCharacterId
      ? await store.listMemories({ characterId: activeCharacterId, includeInactive: true, limit: 500 })
      : [];

    // Restore the linked backup folder, if one was chosen in an earlier session.
    if (isFolderAccessSupported()) {
      const handle = await loadHandle();
      if (handle) {
        services.folder = handle;
        const writable = await canWrite(handle);
        set({
          folderStatus: writable ? 'connected' : 'needs-permission',
          folderName: handle.name,
          ...(writable ? {} : { folderError: 'Click "Save to folder" to re-grant access.' }),
        });
      }
    }

    const engine = new AuraEngine({
      store,
      credentials,
      settings: () => get().settings,
      callbacks: {
        onStatus: (status) => set({ status }),
        onMessagesChanged: () => {
          void get().refreshMessages();
        },
        onTurn: (turn: StructuredTurn, diagnostics: TurnDiagnostics) => {
          services.engine?.jsonForDiagnostics(turn, diagnostics);
          set((state) => ({
            diagnostics: [diagnostics, ...state.diagnostics].slice(0, 20),
            diagnosticsJson:
              state.settings.diagnosticsEnabled
                ? services.engine?.jsonForDiagnostics(turn, diagnostics)
                : state.diagnosticsJson,
          }));
        },
        onMood: (mood) => set({ mood }),
        onSpeaking: (speaking) => set({ speaking }),
        onLiveStatus: (live) => set({ live }),
        onCaption: (caption) =>
          set((state) => {
            const id = `${caption.role}-${state.captions.length}`;
            return { captions: [...state.captions, { id, ...caption }].slice(-40) };
          }),
        onAssetSummary: (assetSummary) => set({ assetSummary }),
        onQuality: (quality, qualityReason) => set({ quality, qualityReason }),
        onError: (status) => set({ status }),
      },
    });
    services.engine = engine;

    set({
      ready: true,
      settings,
      credentialStatus,
      characters,
      activeCharacterId,
      conversations,
      activeConversationId,
      messages,
      memories,
      quality: settings.quality,
      onboardingStep: credentialStatus.hasKey || settings.useMockProviders ? 'done' : 0,
      status: credentialStatus.hasKey
        ? 'Ready.'
        : 'Add your Gemini API key in Settings, or explore the offline demo.',
    });
  },

  attachCanvas(canvas) {
    services.engine?.attachCanvas(canvas);
  },

  async sendMessage(text) {
    const state = get();
    const character = state.characters.find((entry) => entry.id === state.activeCharacterId);
    if (!character) return;
    let conversation = state.conversations.find((entry) => entry.id === state.activeConversationId);
    if (!conversation) {
      await get().newConversation();
      conversation = get().conversations.find((entry) => entry.id === get().activeConversationId);
    }
    if (!conversation) return;

    const titleNeeded = conversation.title === 'New chat';
    set({ status: 'Thinking…' });
    try {
      await services.engine?.sendTextTurn({ character, conversation, text });
      const store = services.store;
      if (store && titleNeeded) {
        const updated = await store.getConversation(conversation.id);
        if (updated) {
          await store.saveConversation({
            ...updated,
            title: titleFromFirstMessage(text),
            updatedAt: nowIso(),
          });
        }
      }
    } catch (error) {
      set({ status: describeProviderError(error) });
    } finally {
      await get().refreshMessages();
      const conversations = await services.store?.listConversations(get().activeCharacterId);
      set({ conversations: conversations ?? get().conversations });
    }
  },

  interrupt() {
    services.engine?.interrupt();
  },

  async startLive() {
    const state = get();
    const character = state.characters.find((entry) => entry.id === state.activeCharacterId);
    if (!character) return;
    let conversation = state.conversations.find((entry) => entry.id === state.activeConversationId);
    if (!conversation) {
      await get().newConversation();
      conversation = get().conversations.find((entry) => entry.id === get().activeConversationId);
    }
    set({ captions: [], status: 'Starting Live mode…' });
    try {
      await services.engine?.startLive({ character });
    } catch (error) {
      set({ status: describeProviderError(error) });
    }
    void conversation;
  },

  async stopLive() {
    const state = get();
    const conversation = state.conversations.find((entry) => entry.id === state.activeConversationId);
    await services.engine?.stopLive();
    if (conversation && state.captions.length > 0) {
      const finalOnly = state.captions.filter((caption) => caption.text.trim().length > 0);
      await services.engine?.persistCaptions(conversation, finalOnly);
      await get().reloadMemories();
    }
  },

  sendLiveText(text) {
    services.engine?.sendLiveText(text);
  },

  setLiveMuted(muted) {
    services.engine?.setLiveMuted(muted);
    set((state) => ({ live: { ...state.live, micMuted: muted } }));
  },

  async updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    if (services.store) await saveSettings(services.store, settings);
    if (patch.quality) services.engine?.setQuality(patch.quality);
    if (patch.quality) set({ quality: patch.quality });
  },

  async setApiKey(key) {
    const credentials = services.credentials;
    if (!credentials) return;
    await credentials.setKey(key);
    const credentialStatus = await credentials.status();
    set({ credentialStatus, onboardingStep: 'done', status: 'API key saved.' });
  },

  async clearApiKey() {
    const credentials = services.credentials;
    if (!credentials) return;
    await credentials.clear();
    const credentialStatus = await credentials.status();
    set({ credentialStatus, status: 'API key removed from this device.' });
  },

  async saveActiveCharacter(patch) {
    const state = get();
    const character = state.characters.find((entry) => entry.id === state.activeCharacterId);
    const store = services.store;
    if (!character || !store) return;
    const promptChanged = patch.promptText !== undefined && patch.promptText !== character.promptText;
    const updated: CharacterRecord = {
      ...character,
      ...patch,
      promptVersion: promptChanged ? character.promptVersion + 1 : character.promptVersion,
      updatedAt: nowIso(),
      manifestJson: patch.name ? manifestFor(character.id, patch.name) : character.manifestJson,
    };
    await store.saveCharacter(updated);
    set({
      characters: state.characters.map((entry) => (entry.id === updated.id ? updated : entry)),
      status: promptChanged ? 'Personality saved as a new prompt version.' : 'Character saved.',
    });
  },

  async createCharacter(input) {
    const store = services.store;
    if (!store) return;
    const character = characterFromInput({ id: createId('char'), name: input.name, prompt: input.prompt });
    await store.saveCharacter(character);
    set((state) => ({ characters: [...state.characters, character], activeCharacterId: character.id }));
    await get().newConversation();
  },

  async selectCharacter(id) {
    const store = services.store;
    if (!store) return;
    const conversations = await store.listConversations(id);
    const activeConversationId = conversations[0]?.id;
    const messages = activeConversationId ? await store.listMessages(activeConversationId) : [];
    const memories = await store.listMemories({ characterId: id, includeInactive: true, limit: 500 });
    set({ activeCharacterId: id, conversations, activeConversationId, messages, memories });
  },

  async newConversation(options) {
    const store = services.store;
    const state = get();
    const characterId = state.activeCharacterId;
    if (!store || !characterId) return;
    const conversation: ConversationRecord = {
      id: createId('conv'),
      characterId,
      title: 'New chat',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ephemeral: options?.ephemeral,
    };
    await store.saveConversation(conversation);
    set({
      conversations: [conversation, ...state.conversations],
      activeConversationId: conversation.id,
      messages: [],
      status: options?.ephemeral
        ? 'Temporary chat: nothing from this chat is saved.'
        : 'New chat started.',
    });
  },

  async selectConversation(id) {
    const store = services.store;
    if (!store) return;
    const messages = await store.listMessages(id);
    set({ activeConversationId: id, messages });
  },

  async deleteConversation(id) {
    const store = services.store;
    if (!store) return;
    await store.deleteConversation(id);
    const conversations = await store.listConversations(get().activeCharacterId);
    const activeConversationId = conversations[0]?.id;
    const messages = activeConversationId ? await store.listMessages(activeConversationId) : [];
    set({ conversations, activeConversationId, messages, status: 'Conversation deleted.' });
  },

  async branchConversation(messageId) {
    const store = services.store;
    const state = get();
    const source = state.conversations.find((entry) => entry.id === state.activeConversationId);
    if (!store || !source) return;
    const all = await store.listMessages(source.id);
    const branchPoint = all.findIndex((message) => message.id === messageId);
    const kept = all.slice(0, branchPoint + 1);
    const branch: ConversationRecord = {
      id: createId('conv'),
      characterId: source.characterId,
      parentConversationId: source.id,
      parentMessageId: messageId,
      title: `${source.title} (branch)`,
      summary: source.summary,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await store.saveConversation(branch);
    for (const message of kept) {
      await store.appendMessage({ ...message, id: createId('msg'), conversationId: branch.id });
    }
    const conversations = await store.listConversations(state.activeCharacterId);
    set({
      conversations,
      activeConversationId: branch.id,
      messages: await store.listMessages(branch.id),
      status: 'Branch created. The original chat is unchanged.',
    });
  },

  async importVrm(file) {
    try {
      const buffer = await file.arrayBuffer();
      await services.engine?.importVrm(buffer, file.name);
    } catch (error) {
      set({ status: error instanceof Error ? error.message : String(error) });
    }
  },

  async importVrma(file) {
    try {
      const buffer = await file.arrayBuffer();
      await services.engine?.importVrma(buffer, file.name);
    } catch (error) {
      set({ status: error instanceof Error ? error.message : String(error) });
    }
  },

  async useProceduralAvatar() {
    await services.engine?.loadProceduralAvatar();
    set({ status: 'Using the built-in placeholder character.', assetSummary: undefined });
  },

  async reloadMemories() {
    const state = get();
    if (!state.activeCharacterId || !services.store) return;
    const memories = await services.store.listMemories({
      characterId: state.activeCharacterId,
      includeInactive: true,
      limit: 500,
    });
    set({ memories });
  },

  async deleteMemory(id) {
    await services.engine?.deleteMemory(id);
    await get().reloadMemories();
    set({ status: 'Memory deleted. It will not be used in future replies.' });
  },

  async setMemoryStatus(id, status) {
    await services.engine?.setMemoryStatus(id, status);
    await get().reloadMemories();
  },

  async exportData() {
    const store = services.store;
    if (!store) return '';
    const bundle = await store.exportAll();
    set({ status: 'Export prepared. API keys are never included.' });
    return JSON.stringify(bundle, null, 2);
  },

  async importData(json, mode) {
    const store = services.store;
    if (!store) return;
    const bundle = JSON.parse(json) as Parameters<Store['importAll']>[0];
    await store.importAll(bundle, mode);
    const characters = await store.listCharacters();
    const conversations = await store.listConversations(characters[0]?.id);
    set({ characters, conversations, status: 'Import complete.' });
  },

  async purgeAll() {
    await services.store?.purgeAll();
    set({ characters: [], conversations: [], messages: [], memories: [], status: 'All local data deleted.' });
    await get().init();
  },

  async connectFolder() {
    if (!isFolderAccessSupported()) {
      set({ folderStatus: 'error', folderError: 'This browser does not support folder access. Use Chrome or Edge.' });
      return;
    }
    try {
      const handle = await pickFolder();
      services.folder = handle;
      await saveHandle(handle);
      set({ folderStatus: 'connected', folderName: handle.name, folderError: undefined });
      await get().saveToFolder();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A cancelled picker is not an error worth surfacing loudly.
      if (/abort|cancel/i.test(message)) return;
      set({ folderStatus: 'error', folderError: message });
    }
  },

  async saveToFolder() {
    const store = services.store;
    const handle = services.folder;
    if (!store || !handle) {
      set({ folderStatus: 'error', folderError: 'No folder connected yet.' });
      return;
    }
    try {
      const allowed = await ensureWritePermission(handle);
      if (!allowed) {
        set({ folderStatus: 'needs-permission', folderError: 'Browser needs permission to write to that folder.' });
        return;
      }
      const bundle = await store.exportAll();
      await writeBundleToFolder(handle, bundle);
      set({
        folderStatus: 'connected',
        folderName: handle.name,
        folderLastSavedAt: nowIso(),
        folderError: undefined,
        status: `Saved to ${handle.name}.`,
      });
    } catch (error) {
      set({
        folderStatus: 'error',
        folderError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async loadFromFolder() {
    const store = services.store;
    let handle = services.folder;
    if (!handle) {
      handle = (await loadHandle()) ?? undefined;
      if (!handle) {
        set({ folderStatus: 'error', folderError: 'No saved folder. Connect one first.' });
        return;
      }
      services.folder = handle;
    }
    try {
      const allowed = await ensureWritePermission(handle);
      if (!allowed) {
        set({ folderStatus: 'needs-permission', folderError: 'Browser needs permission to read that folder.' });
        return;
      }
      const manifest = await readManifest(handle);
      const bundle = await readBundleFromFolder(handle);
      if (!bundle) {
        set({ folderStatus: 'connected', folderName: handle.name, folderError: 'That folder has no AURA backup yet.' });
        return;
      }
      await store?.importAll(bundle, 'merge');
      const characters = await store?.listCharacters();
      const conversations = await store?.listConversations(characters?.[0]?.id);
      set({
        characters: characters ?? [],
        conversations: conversations ?? [],
        folderStatus: 'connected',
        folderName: handle.name,
        folderError: undefined,
        status: `Loaded ${manifest?.counts.conversations ?? bundle.conversations.length} chats from ${handle.name}.`,
      });
      await get().refreshMessages();
      await get().reloadMemories();
    } catch (error) {
      set({
        folderStatus: 'error',
        folderError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async disconnectFolder() {
    services.folder = undefined;
    await clearHandle();
    set({ folderStatus: 'none', folderName: undefined, folderLastSavedAt: undefined, folderError: undefined });
  },

  setDialog(dialog, open) {
    if (dialog === 'history') set({ showHistory: open });
    if (dialog === 'settings') set({ showSettings: open });
    if (dialog === 'memory') set({ showMemory: open });
    if (dialog === 'character') set({ showCharacter: open });
  },

  setOnboardingStep(step) {
    set({ onboardingStep: step });
  },

  async refreshMessages() {
    const state = get();
    if (!services.store || !state.activeConversationId) return;
    const messages = await services.store.listMessages(state.activeConversationId);
    set({ messages });
  },
}));

export function credentialHint(status: CredentialStatus): string {
  return describeCredentialLocation(status);
}

export function getEngine(): AuraEngine | undefined {
  return services.engine;
}

export function getStore(): Store | undefined {
  return services.store;
}
