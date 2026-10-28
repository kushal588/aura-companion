import type { Store } from '../storage';
import type { MemoryMode } from '../memory/MemoryService';
import { DEFAULT_MODELS } from '../providers/gemini/ModelCapabilities';
import { DEFAULT_LIVE_SETTINGS } from '../types/live';
import type { QualityTier } from '../avatar/AvatarStage';

/**
 * User settings (PLAN §3.3 screen 7). Persisted as one JSON blob in the local
 * database. No secrets: the API key lives in the OS credential store.
 */

export interface AppSettings {
  schemaVersion: number;
  textModelId: string;
  ttsModelId: string;
  liveModelId: string;
  voiceName: string;
  ttsEnabled: boolean;
  temperature: number;
  maxOutputTokens: number;
  memoryMode: MemoryMode;
  memoryMaxItems: number;
  saveLiveTranscripts: boolean;
  quality: QualityTier;
  theme: 'dark' | 'light' | 'system';
  expressiveness: number;
  reducedMotion: boolean;
  fontSize: 'small' | 'medium' | 'large';
  harborTitleBar: boolean;
  diagnosticsEnabled: boolean;
  useMockProviders: boolean;
  liveChunkMs: number;
  liveMaxBufferMs: number;
  /** Model IDs are free-text because the catalogue changes; this records when
   *  the list was last refreshed from the provider. */
  modelsRefreshedAt?: string;
}

export const SETTINGS_KEY = 'app.settings';

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  // Gemini 2.5 Flash family: the cheapest sensible default (see README).
  textModelId: DEFAULT_MODELS.text,
  ttsModelId: DEFAULT_MODELS.tts,
  liveModelId: DEFAULT_MODELS.live,
  voiceName: 'Kore',
  ttsEnabled: true,
  temperature: 0.9,
  maxOutputTokens: 2048,
  memoryMode: 'auto_review',
  memoryMaxItems: 200,
  saveLiveTranscripts: true,
  quality: 'balanced',
  theme: 'dark',
  expressiveness: 1,
  reducedMotion: false,
  fontSize: 'medium',
  harborTitleBar: false,
  diagnosticsEnabled: false,
  useMockProviders: import.meta.env?.VITE_AURA_MOCK_PROVIDERS === '1',
  liveChunkMs: DEFAULT_LIVE_SETTINGS.chunkMs,
  liveMaxBufferMs: DEFAULT_LIVE_SETTINGS.maxBufferMs,
};

export async function loadSettings(store: Store): Promise<AppSettings> {
  const raw = await store.getSetting(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(store: Store, settings: AppSettings): Promise<void> {
  await store.setSetting(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
}

/** Clamp anything a user (or a hand-edited row) could put out of range. */
export function sanitizeSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    schemaVersion: 1,
    temperature: clamp(settings.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    maxOutputTokens: clamp(Math.round(settings.maxOutputTokens), 128, 8192, 2048),
    memoryMaxItems: clamp(Math.round(settings.memoryMaxItems), 0, 2000, 200),
    expressiveness: clamp(settings.expressiveness, 0.2, 2, 1),
    liveChunkMs: clamp(Math.round(settings.liveChunkMs), 20, 100, 32),
    liveMaxBufferMs: clamp(Math.round(settings.liveMaxBufferMs), 250, 5000, 1500),
    textModelId: settings.textModelId.trim() || DEFAULT_SETTINGS.textModelId,
    ttsModelId: settings.ttsModelId.trim() || DEFAULT_SETTINGS.ttsModelId,
    liveModelId: settings.liveModelId.trim() || DEFAULT_SETTINGS.liveModelId,
    voiceName: settings.voiceName.trim() || DEFAULT_SETTINGS.voiceName,
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
