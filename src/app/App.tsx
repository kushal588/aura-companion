import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAura } from './store';
import { AvatarViewport } from '../components/AvatarViewport';
import { ChatPanel } from '../components/ChatPanel';
import { SettingsDialog } from '../components/SettingsDialog';
import { CharacterEditorDialog } from '../components/CharacterEditorDialog';
import { MemoryDialog } from '../components/MemoryDialog';
import { HistoryDialog } from '../components/HistoryDialog';
import { Onboarding } from '../components/Onboarding';
import { Dialog } from '../components/Dialog';
import type { QualityTier } from '../avatar/AvatarStage';

/**
 * Main window (PLAN §3.1, §3.2).
 *
 * Desktop landscape: ~65% avatar / 35% chat with a draggable splitter, plus an
 * immersive mode that hides the chat. Phone portrait: the avatar takes the top
 * ~58% and the chat becomes a bottom sheet — two narrow columns are never
 * squeezed onto a phone screen.
 */
export function App(): ReactNode {
  const ready = useAura((state) => state.ready);
  const init = useAura((state) => state.init);
  const status = useAura((state) => state.status);
  const onboardingStep = useAura((state) => state.onboardingStep);
  const format = useAura((state) => state.settings.fontSize);
  const theme = useAura((state) => state.settings.theme);
  const showSettings = useAura((state) => state.showSettings);
  const showHistory = useAura((state) => state.showHistory);
  const showMemory = useAura((state) => state.showMemory);
  const showCharacter = useAura((state) => state.showCharacter);
  const settings = useAura((state) => state.settings);
  const updateSettings = useAura((state) => state.updateSettings);
  const setDialog = useAura((state) => state.setDialog);
  const characters = useAura((state) => state.characters);
  const activeCharacterId = useAura((state) => state.activeCharacterId);
  const selectCharacter = useAura((state) => state.selectCharacter);
  const newConversation = useAura((state) => state.newConversation);
  const startLive = useAura((state) => state.startLive);
  const stopLive = useAura((state) => state.stopLive);
  const live = useAura((state) => state.live);

  const [splitRatio, setSplitRatio] = useState(0.65);
  const [immersive, setImmersive] = useState(false);
  const splitContainer = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const root = document.documentElement;
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    root.dataset['theme'] = resolved;
    root.dataset['fontSize'] = format;
  }, [theme, format]);

  const startDrag = (): void => {
    const onMove = (event: PointerEvent): void => {
      const container = splitContainer.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
      setSplitRatio(Math.min(0.85, Math.max(0.35, ratio)));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot__card">
          <h1>AURA</h1>
          <p>Loading your local conversations…</p>
          <p className="muted">No account needed. Nothing leaves this device until you send a message.</p>
        </div>
      </div>
    );
  }

  const activeCharacter = characters.find((character) => character.id === activeCharacterId);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar__brand">
          <span className="toolbar__logo" aria-hidden="true" />
          <strong>AURA</strong>
        </div>

        <label className="toolbar__field">
          <span className="sr-only">Character</span>
          <select
            value={activeCharacterId ?? ''}
            onChange={(event) => void selectCharacter(event.target.value)}
          >
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </label>

        <div className="toolbar__actions">
          <button type="button" onClick={() => void newConversation()} title="Start a new chat">
            New chat
          </button>
          <button
            type="button"
            className={live.state !== 'idle' && live.state !== 'disconnected' ? 'danger' : ''}
            onClick={() => void (live.state === 'idle' ? startLive() : stopLive())}
            title="Start or stop an audio-only Live conversation"
          >
            {live.state === 'idle' ? '🎙 Live' : '■ End Live'}
          </button>
          <button type="button" onClick={() => setImmersive((value) => !value)} title="Hide the chat panel">
            {immersive ? 'Show chat' : 'Immersive'}
          </button>
          <button type="button" onClick={() => setDialog('history', true)}>
            History
          </button>
          <button type="button" onClick={() => setDialog('character', true)}>
            Character
          </button>
          <button type="button" onClick={() => setDialog('memory', true)}>
            Memory
          </button>
          <button type="button" onClick={() => setDialog('settings', true)} aria-label="Settings">
            ⚙
          </button>
        </div>
      </header>

      <main className="layout" ref={splitContainer}>
        <section className="layout__stage" style={{ flexBasis: immersive ? '100%' : `${splitRatio * 100}%` }}>
          <AvatarViewport />
        </section>

        {!immersive && (
          <>
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat panel"
              tabIndex={0}
              onPointerDown={startDrag}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') setSplitRatio((value) => Math.max(0.35, value - 0.03));
                if (event.key === 'ArrowRight') setSplitRatio((value) => Math.min(0.85, value + 0.03));
              }}
            />
            <section className="layout__chat">
              <ChatPanel />
            </section>
          </>
        )}
      </main>

      <footer className="statusbar">
        <span className={`dot dot--${live.state}`} aria-hidden="true" />
        <span className="statusbar__text">{status}</span>
        <span className="spacer" />
        <span className="muted">
          {live.state !== 'idle' ? `Live: ${live.state}` : `Quality: ${settings.quality}`} ·{' '}
          {activeCharacter ? activeCharacter.name : 'No character'}
        </span>
        <label className="statusbar__field">
          <span className="sr-only">Quality</span>
          <select
            value={settings.quality}
            onChange={(event) => void updateSettings({ quality: event.target.value as QualityTier })}
          >
            <option value="low">Low</option>
            <option value="balanced">Balanced</option>
            <option value="high">High</option>
          </select>
        </label>
      </footer>

      {onboardingStep !== 'done' && <Onboarding />}
      <Dialog open={showSettings} title="Settings" onClose={() => setDialog('settings', false)}>
        <SettingsDialog />
      </Dialog>
      <Dialog open={showCharacter} title="Character" onClose={() => setDialog('character', false)}>
        <CharacterEditorDialog />
      </Dialog>
      <Dialog open={showMemory} title="Long-term memory" onClose={() => setDialog('memory', false)}>
        <MemoryDialog />
      </Dialog>
      <Dialog open={showHistory} title="Conversations" onClose={() => setDialog('history', false)}>
        <HistoryDialog />
      </Dialog>
    </div>
  );
}
