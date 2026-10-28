import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAura } from '../app/store';
import { parseManifest } from '../character/characterSchema';

/**
 * Character editor (PLAN §3.3 screen 3): name, personality prompt, avatar import
 * and animation import.
 *
 * Prompt edits increment the stored prompt version, so a conversation keeps an
 * audit reference to the version that produced each turn.
 */
export function CharacterEditorDialog(): ReactNode {
  const characters = useAura((state) => state.characters);
  const activeCharacterId = useAura((state) => state.activeCharacterId);
  const saveActiveCharacter = useAura((state) => state.saveActiveCharacter);
  const createCharacter = useAura((state) => state.createCharacter);
  const importVrm = useAura((state) => state.importVrm);
  const importVrma = useAura((state) => state.importVrma);
  const useProceduralAvatar = useAura((state) => state.useProceduralAvatar);
  const assetSummary = useAura((state) => state.assetSummary);
  const status = useAura((state) => state.status);

  const character = characters.find((entry) => entry.id === activeCharacterId);
  const [name, setName] = useState(character?.name ?? '');
  const [prompt, setPrompt] = useState(character?.promptText ?? '');
  const [newName, setNewName] = useState('');
  const vrmInput = useRef<HTMLInputElement | null>(null);
  const vrmaInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setName(character?.name ?? '');
    setPrompt(character?.promptText ?? '');
  }, [character?.id, character?.name, character?.promptText]);

  const manifest = character ? parseManifest(character.manifestJson) : undefined;

  return (
    <div className="settings">
      <section>
        <h3>Identity</h3>
        <div className="grid">
          <label>
            Display name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Voice preset
            <input
              value={manifest?.voice.voiceId ?? 'Kore'}
              onChange={(event) =>
                character &&
                void useAura.getState().saveActiveCharacter({
                  manifestJson: JSON.stringify(
                    { ...(manifest ?? {}), voice: { provider: 'gemini', voiceId: event.target.value } },
                    null,
                    2,
                  ),
                })
              }
            />
          </label>
        </div>
        <p className="muted">
          Prompt version {character?.promptVersion ?? 1}. Turns keep the version they were generated with, so an older
          chat still shows the personality it used.
        </p>
      </section>

      <section>
        <h3>Personality prompt</h3>
        <textarea rows={9} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        <p className="muted">
          This text shapes style and tone. It cannot change AURA&apos;s safety rules, read your files or reveal
          credentials — anything in it that tries is ignored.
        </p>
        <div className="row">
          <button
            type="button"
            onClick={() => void saveActiveCharacter({ name, promptText: prompt })}
            disabled={!character}
          >
            Save character
          </button>
          <button
            type="button"
            onClick={() => {
              void useAura.getState().saveActiveCharacter({
                name,
                promptText: `You are ${name || 'a character'}. ${
                  prompt.replace(/^You are [^.]+\.\s*/i, '')
                }`.trim(),
              });
            }}
            disabled={!character}
          >
            Rewrite opening line
          </button>
        </div>
      </section>

      <section>
        <h3>Avatar</h3>
        <p className="muted">
          Import a .vrm model you have the rights to use. Files stay in your local app data folder and are never
          uploaded. AURA ships no third-party avatars.
        </p>
        <div className="row">
          <button type="button" onClick={() => vrmInput.current?.click()}>
            Import .vrm avatar
          </button>
          <button type="button" onClick={() => vrmaInput.current?.click()} disabled={!assetSummary}>
            Import .vrma animation
          </button>
          <button type="button" onClick={() => void useProceduralAvatar()}>
            Use built-in placeholder
          </button>
        </div>
        <input
          ref={vrmInput}
          type="file"
          accept=".vrm,.glb"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importVrm(file);
            event.target.value = '';
          }}
        />
        <input
          ref={vrmaInput}
          type="file"
          accept=".vrma,.glb"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importVrma(file);
            event.target.value = '';
          }}
        />
        {assetSummary && (
          <ul className="summary">
            <li>VRM version: {assetSummary.vrmVersion}</li>
            <li>Humanoid bones found: {assetSummary.bones}</li>
            <li>Triangles: {assetSummary.triangles.toLocaleString()}</li>
            <li>Expressions: {assetSummary.expressions.join(', ') || 'none reported'}</li>
            <li>Animation clips: {assetSummary.clips.join(', ') || 'none'}</li>
          </ul>
        )}
      </section>

      <section>
        <h3>New character</h3>
        <div className="row">
          <input placeholder="Character name" value={newName} onChange={(event) => setNewName(event.target.value)} />
          <button
            type="button"
            disabled={newName.trim().length === 0}
            onClick={() => {
              void createCharacter({ name: newName.trim(), prompt: prompt.trim() || 'A warm, curious companion.' });
              setNewName('');
            }}
          >
            Create
          </button>
        </div>
      </section>

      <p className="muted">{status}</p>
    </div>
  );
}
