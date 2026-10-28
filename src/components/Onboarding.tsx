import { useState, type ReactNode } from 'react';
import { credentialHint, useAura } from '../app/store';
import { DEFAULT_MODELS } from '../providers/gemini/ModelCapabilities';

const STEPS = ['Welcome', 'Privacy', 'Your API key', 'Character', 'Start chatting'] as const;

/**
 * First-run onboarding (PLAN §3.3 screen 1).
 *
 * Explains plainly that local storage is not the same as offline operation, asks
 * for the user's own key, offers a real connection test and a sample character,
 * and never blocks the user from exploring without a key.
 */
export function Onboarding(): ReactNode {
  const step = useAura((state) => state.onboardingStep);
  const setStep = useAura((state) => state.setOnboardingStep);
  const setApiKey = useAura((state) => state.setApiKey);
  const credentialStatus = useAura((state) => state.credentialStatus);
  const updateSettings = useAura((state) => state.updateSettings);
  const settings = useAura((state) => state.settings);
  const useProceduralAvatar = useAura((state) => state.useProceduralAvatar);
  const importVrm = useAura((state) => state.importVrm);
  const [keyDraft, setKeyDraft] = useState('');
  const [testResult, setTestResult] = useState<string>();

  if (step === 'done') return null;
  const index = typeof step === 'number' ? step : 0;

  const runConnectionTest = async (): Promise<void> => {
    setTestResult('Testing…');
    if (settings.useMockProviders) {
      setTestResult('Offline demo mode is on, so no test request is needed.');
      return;
    }
    try {
      const { testGeminiTextConnection } = await import('../providers/gemini/GeminiChatAdapter');
      const key = keyDraft.trim();
      if (key.length > 8) await setApiKey(key);
      const hasKey = key.length > 8 || useAura.getState().credentialStatus.hasKey;
      if (!hasKey) {
        setTestResult('Enter your key first, or turn on offline demo mode.');
        return;
      }
      const result = await testGeminiTextConnection({
        auth: { kind: 'inline', apiKey: key },
        modelId: settings.textModelId || DEFAULT_MODELS.text,
        signal: new AbortController().signal,
      });
      setTestResult(result.ok ? 'Connection works.' : `Could not reach the model: ${result.message}`);
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="modal" role="presentation">
      <div className="modal__panel modal__panel--onboarding" role="dialog" aria-modal="true" aria-label="Welcome">
        <header className="modal__header">
          <h2>
            {STEPS[index]} · step {index + 1} of {STEPS.length}
          </h2>
        </header>
        <div className="modal__body">
          {index === 0 && (
            <section>
              <p>
                AURA is a 3D AI character companion that runs on your own computer. Type or talk, and the character
                answers with a voice, a face and simple body language.
              </p>
              <ul>
                <li>Your chats, memories and avatar files are stored locally on this device.</li>
                <li>You bring your own Gemini API key; there is no account and no AURA server.</li>
                <li>
                  Text replies default to <strong>{DEFAULT_MODELS.text}</strong> to keep costs low. You can change every
                  model in Settings.
                </li>
                <li>Characters are clearly fictional AI. AURA is not a replacement for real relationships.</li>
              </ul>
            </section>
          )}

          {index === 1 && (
            <section>
              <h3>What stays local, and what does not</h3>
              <p>
                Conversations, memories and imported avatars stay in this app&apos;s local data folder. AURA has no
                telemetry by default.
              </p>
              <p>
                When you send a message, that message, the recent turns and the memories used are sent to Google&apos;s
                Gemini API and are governed by Google&apos;s terms and privacy policy. Live mode also sends microphone
                audio while the session is open. AURA never records or stores microphone audio.
              </p>
              <p className="muted">
                That is why local storage is not the same as working offline: nothing is sent until you send it, but it
                does leave the device when you do.
              </p>
            </section>
          )}

          {index === 2 && (
            <section>
              <h3>Add your Gemini API key</h3>
              <p className="muted">{credentialHint(credentialStatus)}</p>
              <div className="row">
                <input
                  type="password"
                  placeholder="Paste key (or skip and use offline demo mode)"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (keyDraft.trim().length > 8) void setApiKey(keyDraft).then(() => setKeyDraft(''));
                  }}
                  disabled={keyDraft.trim().length <= 8}
                >
                  Save
                </button>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.useMockProviders}
                  onChange={(event) => void updateSettings({ useMockProviders: event.target.checked })}
                />
                Use offline demo mode instead (no key, no network, no cost)
              </label>
              <div className="row">
                <button type="button" onClick={() => void runConnectionTest()}>
                  Test connection
                </button>
              </div>
              {testResult && <p className="muted">{testResult}</p>}
            </section>
          )}

          {index === 3 && (
            <section>
              <h3>Pick a character</h3>
              <p>
                Import your own VRM avatar, or continue with the built-in placeholder character and swap it later. AURA
                ships no third-party models: import files you have the rights to use.
              </p>
              <div className="row">
                <label>
                  Import .vrm
                  <input
                    type="file"
                    accept=".vrm,.glb"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importVrm(file);
                    }}
                  />
                </label>
                <button type="button" onClick={() => void useProceduralAvatar()}>
                  Use placeholder character
                </button>
              </div>
            </section>
          )}

          {index === 4 && (
            <section>
              <h3>You are ready</h3>
              <p>
                Type a message, or press <strong>Live</strong> for a voice conversation. Press <strong>Stop</strong> at
                any time to cut a reply short, and use the Memory panel to see or correct anything the character
                remembers.
              </p>
            </section>
          )}

          <footer className="row">
            <button type="button" onClick={() => setStep(Math.max(0, index - 1))} disabled={index === 0}>
              Back
            </button>
            <span className="spacer" />
            <button type="button" onClick={() => setStep('done')}>
              Skip
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => setStep(index >= STEPS.length - 1 ? 'done' : index + 1)}
            >
              {index >= STEPS.length - 1 ? 'Start' : 'Next'}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
