import { AnimationMixer } from 'three';
import type { Store } from '../storage';
import type { CredentialStore } from './credentials';
import type { AppSettings } from './settings';
import type {
  CharacterRecord,
  ConversationRecord,
  MemoryRecord,
  MessageRecord,
  MoodState,
} from '../types/entities';
import type { StructuredTurn, TurnDiagnostics } from '../types/turn';
import type { AvatarEvent } from '../types/events';
import type { LiveSettings, LiveStatus } from '../types/live';
import type { ChatProvider, TtsProvider } from '../types/model';
import { MemoryService } from '../memory/MemoryService';
import { ConversationOrchestrator } from '../conversation/ConversationOrchestrator';
import { AvatarScheduler } from '../avatar/AvatarScheduler';
import { AvatarExpressionController } from '../avatar/AvatarExpressionController';
import { AvatarMotionController } from '../avatar/AvatarMotionController';
import { LipSyncController } from '../avatar/LipSyncController';
import { AvatarStage, type QualityTier } from '../avatar/AvatarStage';
import { createProceduralAvatar } from '../avatar/proceduralAvatar';
import { VRMAssetManager, type VrmAssetSummary } from '../avatar/VRMAssetManager';
import type { AvatarRig } from '../avatar/types';
import { createAudioPlayback, type AudioPlaybackSink } from '../audio/AudioPlayback';
import { LiveAudioController, type LiveSessionFactory } from '../audio/LiveAudioController';
import { BrowserMicrophoneCapture, type MicrophoneCapture } from '../audio/MicrophoneCapture';
import { GeminiChatAdapter } from '../providers/gemini/GeminiChatAdapter';
import { GeminiTtsAdapter } from '../providers/gemini/GeminiTtsAdapter';
import {
  createGeminiLiveSessionFactory,
  fetchEphemeralToken,
} from '../providers/gemini/GeminiLiveAdapter';
import { MockChatProvider, MockTtsProvider, createMockLiveSessionFactory } from '../providers/mock/MockProviders';
import { buildLiveSystemInstruction } from '../conversation/PromptBuilder';
import type { ExpressionName, Gesture } from '../types/emotion';
import { createId, createSessionId, nowIso } from '../utils/ids';
import { describeProviderError } from '../utils/retry';
import { redactForDiagnostics } from '../utils/redact';

/**
 * Engine: the single owner of runtime services.
 *
 * React components read state from the store and call engine methods; nothing
 * reaches into the audio/render/network layers directly. This keeps the
 * "exactly one writer per channel" rule (scheduler owns event timing, expression
 * controller owns face weights, motion controller owns bones) enforceable.
 */

export interface EngineCallbacks {
  onStatus: (status: string) => void;
  onMessagesChanged: () => void;
  onTurn: (turn: StructuredTurn, diagnostics: TurnDiagnostics) => void;
  onMood: (mood: MoodState) => void;
  onSpeaking: (speaking: boolean) => void;
  onLiveStatus: (status: LiveStatus) => void;
  onCaption: (caption: { role: 'user' | 'assistant'; text: string; final: boolean }) => void;
  onAssetSummary: (summary: VrmAssetSummary | undefined) => void;
  onQuality: (tier: QualityTier, reason: string) => void;
  onError: (message: string) => void;
}

export interface EngineDeps {
  store: Store;
  credentials: CredentialStore;
  settings: () => AppSettings;
  callbacks: EngineCallbacks;
}

export class AuraEngine {
  private readonly deps: EngineDeps;
  private readonly store: Store;
  private readonly credentials: CredentialStore;
  readonly memory: MemoryService;

  private stage?: AvatarStage;
  private rig?: AvatarRig;
  private motion?: AvatarMotionController;
  private expressions?: AvatarExpressionController;
  private lipSync?: LipSyncController;
  private scheduler?: AvatarScheduler;
  private playback?: AudioPlaybackSink;
  private live?: LiveAudioController;
  private orchestrator?: ConversationOrchestrator;
  private chatProvider?: ChatProvider;
  private ttsProvider?: TtsProvider;
  private microphoneFactory: () => MicrophoneCapture = () => new BrowserMicrophoneCapture({ chunkMs: 32 });
  private readonly assets = new VRMAssetManager();
  private sessionId = createSessionId();
  private animationFrame = 0;
  private lastFrameAt = 0;
  private speaking = false;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.credentials = deps.credentials;
    this.memory = new MemoryService(deps.store);
  }

  /** Which avatar model is loaded right now (diagnostics and tests). */
  get avatarKind(): 'vrm' | 'procedural' | undefined {
    return this.rig?.kind;
  }

  // ---------------------------------------------------------------- avatar

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.stage?.dispose();
    this.stage = new AvatarStage({
      canvas,
      quality: this.deps.settings().quality,
      onQualityChange: (tier, reason) => this.deps.callbacks.onQuality(tier, reason),
    });

    this.mountRig(createProceduralAvatar());
    this.stage.start();
    this.startFrameLoop();
  }

  /** Manual expression preview from the viewport overlay. */
  previewExpression(expression: ExpressionName): void {
    this.expressions?.previewExpression(expression);
  }

  /** Manual one-shot gesture preview from the viewport overlay. */
  previewGesture(gesture: Gesture): void {
    this.motion?.playGesture(gesture);
  }

  private mountRig(rig: AvatarRig): void {
    if (!this.stage) return;
    this.motion?.dispose();
    this.rig = rig;
    this.stage.attachRig(rig);

    const mixer = new AnimationMixer(rig.root);
    this.motion = new AvatarMotionController({
      rig,
      mixer,
      expressiveness: this.deps.settings().expressiveness,
    });
    this.expressions = new AvatarExpressionController({
      blinkIntervalRange: [2.4, 6.4],
      lookAt: (yaw, pitch) => rig.lookAt(yaw, pitch),
    });
    this.expressions.attach({
      setExpressionWeight: (name, weight) => rig.setExpressionWeight(name, weight),
      hasExpression: (name) => rig.hasExpression(name),
      applyBlink: (weight) => rig.applyBlink(weight),
    });
    this.lipSync = new LipSyncController();
    if (this.playback) this.lipSync.attach(this.playback);

    // A fresh session per avatar keeps stale events from crossing models.
    this.sessionId = createSessionId();
    this.scheduler = new AvatarScheduler({
      audioClock: () => this.playback?.clockSeconds ?? 0,
      handlers: {
        onEmotion: (emotion, intensity, turnId) => {
          this.expressions?.setEmotion(emotion, intensity);
          this.deps.callbacks.onMood({ emotion, intensity, lastChangedAt: Date.now(), sourceTurnId: turnId });
        },
        onExpression: (expression, intensity) => this.expressions?.setExpression(expression, intensity),
        onGesture: (gesture) => this.motion?.playGesture(gesture),
        onSpeaking: (speaking) => {
          this.speaking = speaking;
          this.motion?.setSpeaking(speaking);
          this.expressions?.setSpeaking(speaking);
          this.lipSync?.setSpeaking(speaking);
          this.deps.callbacks.onSpeaking(speaking);
        },
      },
    });
    this.scheduler.beginSession(this.sessionId);
  }

  private startFrameLoop(): void {
    cancelAnimationFrame(this.animationFrame);
    const loop = (): void => {
      this.animationFrame = requestAnimationFrame(loop);
      const now = performance.now();
      const delta = Math.min(0.1, (now - this.lastFrameAt) / 1000 || 1 / 60);
      this.lastFrameAt = now;
      this.scheduler?.tick(this.playback?.clockSeconds ?? 0, Date.now());
      if (this.playback && this.lipSync) {
        this.lipSync.update();
        this.expressions?.setAudioLevel(this.playback.currentLevel());
      }
      this.expressions?.update(delta);
      this.motion?.update(delta, now / 1000);
    };
    this.animationFrame = requestAnimationFrame(loop);
  }

  setQuality(tier: QualityTier): void {
    this.stage?.setQuality(tier, 'user');
  }

  resetCamera(): void {
    this.stage?.resetView();
  }

  async importVrm(buffer: ArrayBuffer, fileName: string): Promise<VrmAssetSummary> {
    const { loaded, summary } = await this.assets.loadVrmFromBuffer(buffer, fileName);
    this.mountRig(loaded.rig);
    this.deps.callbacks.onAssetSummary(summary);
    this.deps.callbacks.onStatus(
      summary.warnings.length > 0
        ? `Avatar loaded with ${summary.warnings.length} warning(s).`
        : 'Avatar loaded.',
    );
    return summary;
  }

  async importVrma(buffer: ArrayBuffer, fileName: string): Promise<string> {
    const clip = await this.assets.loadAnimationFromBuffer(buffer, fileName);
    this.motion?.registerClips([{ name: clip.name, clip }]);
    this.deps.callbacks.onStatus(`Animation "${clip.name}" added. It plays for matching emotions.`);
    return clip.name;
  }

  async loadProceduralAvatar(): Promise<void> {
    const rig = createProceduralAvatar();
    this.rig = rig;
    this.mountRig(rig);
    this.deps.callbacks.onAssetSummary(undefined);
  }

  // ---------------------------------------------------------- conversation

  private async resolveAuth(): Promise<{ kind: 'native' | 'inline'; apiKey?: string }> {
    if (this.credentials.authKind() === 'native') return { kind: 'native' };
    const key = this.credentials.getKeyForRendererView();
    if (!key) {
      throw new Error('Add your Gemini API key in Settings to enable AI replies.');
    }
    return { kind: 'inline', apiKey: key };
  }

  private async ensureProviders(): Promise<void> {
    const settings = this.deps.settings();
    if (settings.useMockProviders) {
      this.chatProvider ??= new MockChatProvider();
      this.ttsProvider = settings.ttsEnabled ? new MockTtsProvider() : undefined;
      return;
    }

    const auth = await this.resolveAuth();
    const geminiAuth = auth.kind === 'native' ? ({ kind: 'native' } as const) : ({ kind: 'inline', apiKey: auth.apiKey as string } as const);
    this.chatProvider = new GeminiChatAdapter({ auth: geminiAuth });
    this.ttsProvider = settings.ttsEnabled ? new GeminiTtsAdapter({ auth: geminiAuth }) : undefined;
  }

  private ensureOrchestrator(): ConversationOrchestrator {
    this.orchestrator ??= new ConversationOrchestrator({
      store: this.store,
      chat: this.chatProvider ?? new MockChatProvider(),
      tts: this.ttsProvider,
      memory: this.memory,
    });
    return this.orchestrator;
  }

  async sendTextTurn(params: {
    character: CharacterRecord;
    conversation: ConversationRecord;
    text: string;
  }): Promise<void> {
    await this.ensureProviders().catch((error) => {
      this.deps.callbacks.onError(describeProviderError(error));
      throw error;
    });
    const settings = this.deps.settings();
    const orchestrator = this.ensureOrchestrator();
    const result = await orchestrator.sendTextTurn({
      character: params.character,
      conversation: params.conversation,
      text: params.text,
      sessionId: this.sessionId,
      settings: {
        textModelId: settings.textModelId,
        ttsModelId: settings.ttsModelId,
        voiceName: settings.voiceName,
      },
      onTurn: (turn, events) => {
        this.scheduleTurn(turn, events);
        this.deps.callbacks.onMessagesChanged();
      },
      onStatus: (status) => this.deps.callbacks.onStatus(status),
    });

    this.deps.callbacks.onTurn(result.turn, result.diagnostics);
    this.deps.callbacks.onMessagesChanged();

    // Play speech in order, shallow-queued so latency stays low.
    if (result.speech.length > 0 && this.playback) {
      for (const entry of result.speech) {
        if (this.scheduler && this.scheduler.pendingCount === 0 && this.speaking === false) break;
        await this.playback.playResult(entry.result, result.turn.turnId);
      }
    }
  }

  private scheduleTurn(turn: StructuredTurn, events: AvatarEvent[]): void {
    if (!this.scheduler) return;
    const segmentDurations = turn.segments.map((segment) => {
      const words = segment.text.trim().split(/\s+/).filter(Boolean).length;
      return Math.max(0.35, (words / 165) * 60);
    });
    this.scheduler.scheduleTurn({
      turnId: turn.turnId,
      sessionId: this.sessionId,
      turn,
      startAtAudioSeconds: this.playback?.clockSeconds ?? 0,
      segmentDurations,
    });
    void events;
  }

  interrupt(): void {
    this.orchestrator?.interrupt();
    this.scheduler?.interrupt();
    this.playback?.interrupt();
    this.live?.interrupt();
    this.deps.callbacks.onSpeaking(false);
    this.deps.callbacks.onStatus('Stopped.');
  }

  // ---------------------------------------------------------------- live

  async startLive(params: { character: CharacterRecord }): Promise<void> {
    const settings = this.deps.settings();
    if (!this.playback) {
      const sink = createAudioPlayback();
      this.playback = sink;
      this.attachPlaybackSink(sink);
    }
    const playback = this.playback as AudioPlaybackSink;

    let factory: LiveSessionFactory;
    if (settings.useMockProviders) {
      factory = createMockLiveSessionFactory();
    } else {
      const auth = await this.resolveAuth();
      const memoryRetrieved = await this.memory.retrieve({
        characterId: params.character.id,
        query: params.character.name,
        limit: 4,
      });
      const systemInstruction = buildLiveSystemInstruction({
        character: params.character,
        memories: memoryRetrieved.map((entry) => ({
          id: entry.memory.id,
          content: entry.memory.content,
          createdAt: entry.memory.createdAt,
          category: entry.memory.category,
        })),
      });
      const credentials = await fetchEphemeralToken({
        apiKey: auth.apiKey,
        modelId: settings.liveModelId,
        systemInstruction,
        voiceName: settings.voiceName,
        signal: new AbortController().signal,
      });
      factory = createGeminiLiveSessionFactory(
        credentials,
        this.buildLiveSettings(systemInstruction),
      );
    }

    const microphone = this.microphoneFactory();
    this.live = new LiveAudioController({
      factory,
      settings: this.buildLiveSettings(''),
      microphone: async () => {
        const capture = microphone as MicrophoneCapture;
        return {
          start: () => capture.start(),
          stop: () => capture.stop(),
          onChunk: (listener) => capture.onChunk(listener),
        };
      },
      playback,
      onStatus: (status) => {
        this.deps.callbacks.onLiveStatus(status);
        this.motion?.setListening(status.state === 'listening' || status.state === 'user_speaking');
        this.motion?.setSpeaking(status.state === 'model_speaking');
      },
      onTranscript: (transcript) => this.deps.callbacks.onCaption(transcript),
      onInterrupt: () => {
        this.scheduler?.interrupt();
        this.deps.callbacks.onSpeaking(false);
      },
      onGoAway: (timeLeftMs) =>
        this.deps.callbacks.onStatus(
          timeLeftMs ? `The session ends in ${Math.round(timeLeftMs / 1000)}s; reconnecting.` : 'Reconnecting the session.',
        ),
    });

    await this.live.start();
    this.deps.callbacks.onStatus('Live session ready. Speak normally; audio is not recorded.');
  }

  private attachPlaybackSink(sink: AudioPlaybackSink): void {
    this.lipSync?.attach(sink);
  }

  private buildLiveSettings(systemInstruction: string): LiveSettings {
    const settings = this.deps.settings();
    return {
      modelId: settings.liveModelId,
      voiceName: settings.voiceName,
      systemInstruction,
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      chunkMs: settings.liveChunkMs,
      maxBufferMs: settings.liveMaxBufferMs,
      saveTranscripts: settings.saveLiveTranscripts,
    };
  }

  sendLiveText(text: string): void {
    this.live?.sendText(text);
  }

  setLiveMuted(muted: boolean): void {
    this.live?.setMuted(muted);
  }

  async stopLive(): Promise<void> {
    await this.live?.stop();
    this.live = undefined;
    this.deps.callbacks.onStatus('Live session ended.');
  }

  /** Persist finalized captions as live-modality messages (PLAN §8.5). */
  async persistCaptions(
    conversation: ConversationRecord,
    captions: Array<{ role: 'user' | 'assistant'; text: string; final: boolean }>,
  ): Promise<void> {
    if (!this.deps.settings().saveLiveTranscripts) return;
    const liveSessionId = createId('live');
    for (const caption of captions) {
      if (!caption.text.trim()) continue;
      const record: MessageRecord = {
        id: createId('msg'),
        conversationId: conversation.id,
        role: caption.role,
        modality: 'live',
        bodyText: caption.text,
        // Partial transcripts are provisional, never presented as verbatim.
        status: caption.final ? 'complete' : 'pending',
        createdAt: nowIso(),
        extraJson: JSON.stringify({ liveSessionId, transcription: caption.final ? 'final' : 'partial' }),
      };
      await this.store.appendMessage(record);
    }
    this.deps.callbacks.onMessagesChanged();
  }

  // -------------------------------------------------------------- memory

  async listMemories(characterId: string): Promise<MemoryRecord[]> {
    return this.memory.list({ characterId, includeInactive: true });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.memory.remove(id);
  }

  async setMemoryStatus(id: string, status: MemoryRecord['status']): Promise<void> {
    await this.memory.update(id, { status });
  }

  jsonForDiagnostics(turn: StructuredTurn, diagnostics: TurnDiagnostics): string {
    return JSON.stringify(
      {
        turnId: turn.turnId,
        origin: turn.origin,
        segments: turn.segments.length,
        emotions: turn.segments.map((segment) => segment.emotion),
        issues: diagnostics.issues,
        latencyMs: diagnostics.latencyMs,
        model: diagnostics.modelId,
        memoriesUsed: diagnostics.memoriesUsed.map((entry) => entry.id),
        note: 'Diagnostics are redacted: message text, audio and credentials are never included.',
        redacted: redactForDiagnostics(diagnostics.issues.join('; ')),
      },
      null,
      2,
    );
  }

  /** Test hooks / offline mode. */
  useSilentMicrophone(factory: () => MicrophoneCapture): void {
    this.microphoneFactory = factory;
  }

  setPlaybackSink(sink: AudioPlaybackSink): void {
    this.playback = sink;
    this.attachPlaybackSink(sink);
  }


  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.live?.stop().catch(() => undefined);
    this.playback?.dispose();
    this.motion?.dispose();
    this.stage?.dispose();
    this.assets.dispose();
  }
}
