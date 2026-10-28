import { ProviderError, type ModelCapabilities, type ModelDescriptor } from '../../types/model';

/**
 * Capability registry (PLAN §2.3).
 *
 * Model IDs and their features change between releases, so nothing here is
 * assumed: defaults are the cost-efficient models the plan targets (Gemini 2.5
 * Flash family), the user can change every ID in Settings, and `filterModels`
 * narrows the list against what the account can actually reach.
 */

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const GEMINI_WS_CONSTRAINED_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

const TEXT_CAPABILITIES: ModelCapabilities = {
  supportsStructuredOutput: true,
  supportsTtsStreaming: false,
  supportsVoiceStyle: false,
  supportsLiveTranscription: false,
  supportsInterruption: false,
  supportsEphemeralTokens: false,
  contextWindow: 1_000_000,
};

const TTS_CAPABILITIES: ModelCapabilities = {
  supportsStructuredOutput: false,
  supportsTtsStreaming: true,
  supportsVoiceStyle: true,
  supportsLiveTranscription: false,
  supportsInterruption: false,
  supportsEphemeralTokens: false,
  contextWindow: 8192,
};

const LIVE_CAPABILITIES: ModelCapabilities = {
  supportsStructuredOutput: false,
  supportsTtsStreaming: true,
  supportsVoiceStyle: true,
  supportsLiveTranscription: true,
  supportsInterruption: true,
  supportsEphemeralTokens: true,
  contextWindow: 128_000,
};

/**
 * Default model IDs. Verified against the Gemini model catalogue in October 2026.
 * The 2.5 Flash family is the cheapest sensible default; newer models (for
 * example gemini-3.5-flash-lite or gemini-3.8-flash) can be selected in Settings.
 */
export const DEFAULT_MODELS = {
  text: 'gemini-2.5-flash',
  tts: 'gemini-2.5-flash-preview-tts',
  live: 'gemini-2.5-flash-native-audio-preview-12-2025',
} as const;

/** Curated alternates shown in Settings; the field stays free-text. */
export const SUGGESTED_MODELS = {
  text: [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
  ],
  tts: [
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-pro-preview-tts',
    'gemini-3.8-flash-lite-tts',
    'gemini-3.8-flash-tts',
  ],
  live: [
    'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-3.8-live',
    'gemini-3.1-flash-live-preview',
  ],
} as const;

/**
 * Prebuilt voice names. `GET /v1beta/voices` (Voice library) is queried at
 * runtime when reachable; this list keeps the picker usable offline.
 */
export const PREDEFINED_VOICES = [
  'Kore',
  'Puck',
  'Leda',
  'Aoede',
  'Charon',
  'Fenrir',
  'Zephyr',
  'Orus',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
] as const;

export function capabilitiesFor(kind: 'text' | 'tts' | 'live'): ModelCapabilities {
  switch (kind) {
    case 'tts':
      return { ...TTS_CAPABILITIES };
    case 'live':
      return { ...LIVE_CAPABILITIES };
    default:
      return { ...TEXT_CAPABILITIES };
  }
}

/** Heuristic classification of a model ID discovered from `models.list`. */
export function classifyModel(modelId: string): ModelDescriptor['kind'] | undefined {
  const id = modelId.replace(/^models\//, '').toLowerCase();
  if (id.includes('-tts')) return 'tts';
  if (id.includes('-live') || id.includes('native-audio')) return 'live';
  if (id.includes('embedding') || id.includes('image') || id.includes('-transcribe')) return undefined;
  if (id.startsWith('gemini')) return 'text';
  return undefined;
}

export function describeModel(modelId: string): ModelDescriptor | undefined {
  const kind = classifyModel(modelId);
  if (!kind) return undefined;
  return {
    id: modelId.replace(/^models\//, ''),
    displayName: modelId.replace(/^models\//, ''),
    kind,
    capabilities: capabilitiesFor(kind),
  };
}

/**
 * Narrow a discovered model list to the kinds we can use. Returns the curated
 * suggestions when discovery is unavailable, so the UI is never empty.
 */
export function filterModels(
  discovered: string[],
  kind: 'text' | 'tts' | 'live',
): string[] {
  const usable = discovered
    .map((id) => id.replace(/^models\//, ''))
    .filter((id) => classifyModel(id) === kind)
    .sort();
  if (usable.length > 0) {
    // Suggested defaults first, then everything else the account offers.
    const suggested: string[] = [...SUGGESTED_MODELS[kind]].filter((id) => usable.includes(id));
    const rest = usable.filter((id) => !suggested.includes(id));
    return [...suggested, ...rest];
  }
  return [...SUGGESTED_MODELS[kind]];
}

export function assertSupported(
  capability: keyof ModelCapabilities,
  modelId: string,
): void {
  const descriptor = describeModel(modelId);
  if (!descriptor) {
    throw new ProviderError({
      kind: 'bad_request',
      retryable: false,
      message: `Model "${modelId}" is not a supported Gemini model ID for this app.`,
    });
  }
  if (descriptor.capabilities[capability] !== true) {
    throw new ProviderError({
      kind: 'bad_request',
      retryable: false,
      message: `Model "${modelId}" does not support ${capability}.`,
    });
  }
}
