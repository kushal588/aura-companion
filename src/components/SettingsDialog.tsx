import { useState, type ReactNode } from 'react';
import { credentialHint, useAura } from '../app/store';
import { SUGGESTED_MODELS } from '../providers/gemini/ModelCapabilities';

/**
 * Settings (PLAN §3.3 screen 7): models, key management, memory mode, quality,
 * accessibility, diagnostics, export and deletion.
 *
 * Model IDs are free text with suggestions, because the provider catalogue
 * changes: nothing here hardcodes a single permanent model.
 */
export function SettingsDialog(): ReactNode {
  const settings = useAura((state) => state.settings);
  const credentialStatus = useAura((state) => state.credentialStatus);
  const updateSettings = useAura((state) => state.updateSettings);
  const setApiKey = useAura((state) => state.setApiKey);
  const clearApiKey = useAura((state) => state.clearApiKey);
  const exportData = useAura((state) => state.exportData);
  const importData = useAura((state) => state.importData);
  const purgeAll = useAura((state) => state.purgeAll);
  const folderSupported = useAura((state) => state.folderSupported);
  const folderName = useAura((state) => state.folderName);
  const folderStatus = useAura((state) => state.folderStatus);
  const folderLastSavedAt = useAura((state) => state.folderLastSavedAt);
  const folderError = useAura((state) => state.folderError);
  const connectFolder = useAura((state) => state.connectFolder);
  const saveToFolder = useAura((state) => state.saveToFolder);
  const loadFromFolder = useAura((state) => state.loadFromFolder);
  const disconnectFolder = useAura((state) => state.disconnectFolder);
  const diagnosticsJson = useAura((state) => state.diagnosticsJson);
  const [keyDraft, setKeyDraft] = useState('');
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <div className="settings">
      <section>
        <h3>Gemini API key</h3>
        <p className="muted">{credentialHint(credentialStatus)}</p>
        <p className="muted">
          Requests leave your device when you send a message. Google&apos;s terms and privacy policy apply to them.
          AURA stores your chats locally and never bundles a developer key.
        </p>
        <div className="row">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={credentialStatus.hasKey ? 'Key already saved — paste to replace' : 'Paste your Gemini API key'}
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
          />
          <button
            type="button"
            disabled={keyDraft.trim().length < 8}
            onClick={() => {
              void setApiKey(keyDraft).then(() => setKeyDraft(''));
            }}
          >
            Save key
          </button>
          <button type="button" onClick={() => void clearApiKey()} disabled={!credentialStatus.hasKey}>
            Remove key
          </button>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.useMockProviders}
            onChange={(event) => void updateSettings({ useMockProviders: event.target.checked })}
          />
          Offline demo mode (no network, replies are generated locally)
        </label>
      </section>

      <section>
        <h3>Models and voice</h3>
        <div className="grid">
          <label>
            Text model (cost-efficient default: Gemini 2.5 Flash)
            <input
              list="text-models"
              value={settings.textModelId}
              onChange={(event) => void updateSettings({ textModelId: event.target.value })}
            />
            <datalist id="text-models">
              {SUGGESTED_MODELS.text.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <label>
            Speech model
            <input
              list="tts-models"
              value={settings.ttsModelId}
              onChange={(event) => void updateSettings({ ttsModelId: event.target.value })}
            />
            <datalist id="tts-models">
              {SUGGESTED_MODELS.tts.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <label>
            Live model
            <input
              list="live-models"
              value={settings.liveModelId}
              onChange={(event) => void updateSettings({ liveModelId: event.target.value })}
            />
            <datalist id="live-models">
              {SUGGESTED_MODELS.live.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <label>
            Voice
            <input value={settings.voiceName} onChange={(event) => void updateSettings({ voiceName: event.target.value })} />
          </label>
          <label>
            Temperature ({settings.temperature.toFixed(2)})
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={settings.temperature}
              onChange={(event) => void updateSettings({ temperature: Number(event.target.value) })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.ttsEnabled}
              onChange={(event) => void updateSettings({ ttsEnabled: event.target.checked })}
            />
            Speak replies aloud
          </label>
        </div>
        <p className="muted">
          Provider usage is billed to your own API key. Requests are not free, and AURA cannot estimate your spend
          beyond the token counts shown in diagnostics.
        </p>
      </section>

      <section>
        <h3>Memory and privacy</h3>
        <div className="grid">
          <label>
            Memory mode
            <select
              value={settings.memoryMode}
              onChange={(event) => void updateSettings({ memoryMode: event.target.value as typeof settings.memoryMode })}
            >
              <option value="auto_review">Save automatically, review later</option>
              <option value="manual">Ask me before saving</option>
              <option value="disabled">Off — never save memories</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.saveLiveTranscripts}
              onChange={(event) => void updateSettings({ saveLiveTranscripts: event.target.checked })}
            />
            Save Live transcripts when the provider supplies them
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.diagnosticsEnabled}
              onChange={(event) => void updateSettings({ diagnosticsEnabled: event.target.checked })}
            />
            Keep redacted diagnostics (no message text, audio or keys)
          </label>
        </div>
      </section>

      <section>
        <h3>Appearance and accessibility</h3>
        <div className="grid">
          <label>
            Theme
            <select
              value={settings.theme}
              onChange={(event) => void updateSettings({ theme: event.target.value as typeof settings.theme })}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Match system</option>
            </select>
          </label>
          <label>
            Text size
            <select
              value={settings.fontSize}
              onChange={(event) => void updateSettings({ fontSize: event.target.value as typeof settings.fontSize })}
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
          <label>
            Expressiveness ({settings.expressiveness.toFixed(2)})
            <input
              type="range"
              min={0.2}
              max={2}
              step={0.05}
              value={settings.expressiveness}
              onChange={(event) => void updateSettings({ expressiveness: Number(event.target.value) })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.reducedMotion}
              onChange={(event) => void updateSettings({ reducedMotion: event.target.checked })}
            />
            Reduce motion (calmer idle and gestures)
          </label>
        </div>
      </section>

      <section>
        <h3>Your data</h3>
        {folderSupported ? (
          <>
            <p className="muted">
              Save everything — chats, characters and memories — into a folder on this device. The files are plain
              JSON you can open, copy or back up yourself. Nothing is uploaded anywhere.
            </p>
            <div className="row">
              {folderStatus === 'none' ? (
                <button type="button" onClick={() => void connectFolder()}>
                  Choose a folder on this device
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => void saveToFolder()}>
                    Save to folder
                  </button>
                  <button type="button" onClick={() => void loadFromFolder()}>
                    Load from folder
                  </button>
                  <button type="button" onClick={() => void disconnectFolder()}>
                    Disconnect
                  </button>
                </>
              )}
            </div>
            {folderName ? (
              <p className="muted">
                Folder: <strong>{folderName}</strong>
                {folderLastSavedAt
                  ? ` — last saved ${new Date(folderLastSavedAt).toLocaleString()}`
                  : ' — not saved yet'}
              </p>
            ) : null}
            {folderStatus === 'needs-permission' ? (
              <p className="muted">Re-grant access when prompted so AURA can write to that folder again.</p>
            ) : null}
            {folderError ? <p className="muted">{folderError}</p> : null}
          </>
        ) : (
          <p className="muted">
            Folder backup needs the File System Access API (Chrome or Edge). Use the export below in other browsers.
          </p>
        )}
        <div className="row">
          <button
            type="button"
            onClick={() => {
              void exportData().then((json) => {
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `aura-export-${new Date().toISOString().slice(0, 10)}.json`;
                link.click();
                URL.revokeObjectURL(url);
              });
            }}
          >
            Export conversations and memories
          </button>
        </div>
        <p className="muted">Exports never include API keys.</p>
        <details>
          <summary>Import a backup</summary>
          <textarea
            rows={4}
            placeholder="Paste an AURA export here"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
          />
          <div className="row">
            <button
              type="button"
              disabled={importText.trim().length === 0}
              onClick={() => void importData(importText, 'merge').then(() => setImportText(''))}
            >
              Merge import
            </button>
            <button
              type="button"
              disabled={importText.trim().length === 0}
              onClick={() => void importData(importText, 'replace').then(() => setImportText(''))}
            >
              Replace all local data
            </button>
          </div>
        </details>
        <div className="row">
          {confirmPurge ? (
            <>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void purgeAll();
                  setConfirmPurge(false);
                }}
              >
                Yes, delete everything
              </button>
              <button type="button" onClick={() => setConfirmPurge(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmPurge(true)}>
              Delete all local data
            </button>
          )}
        </div>
      </section>

      {settings.diagnosticsEnabled && (
        <section>
          <h3>Diagnostics</h3>
          <pre className="diagnostics">{diagnosticsJson ?? 'No turn recorded yet.'}</pre>
        </section>
      )}
    </div>
  );
}
