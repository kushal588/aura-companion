import { useEffect, useState, type ReactNode } from 'react';
import { useAura } from '../app/store';
import type { MemoryRecord } from '../types/entities';

/**
 * Memory manager (PLAN §9.5, §3.3 screen 5).
 *
 * Shows exactly what the character believes, where it came from, and lets the
 * user disable, edit or delete it. Deleting is permanent and verified: a removed
 * memory is never retrieved again.
 */
export function MemoryDialog(): ReactNode {
  const memories = useAura((state) => state.memories);
  const reloadMemories = useAura((state) => state.reloadMemories);
  const deleteMemory = useAura((state) => state.deleteMemory);
  const setMemoryStatus = useAura((state) => state.setMemoryStatus);
  const settings = useAura((state) => state.settings);
  const updateSettings = useAura((state) => state.updateSettings);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void reloadMemories();
  }, [reloadMemories]);

  const visible = memories.filter((memory) => memory.status !== 'deleted');

  const saveEdit = async (memory: MemoryRecord): Promise<void> => {
    const store = await import('../app/store');
    const engineStore = store.getStore();
    if (!engineStore) return;
    await engineStore.updateMemory(memory.id, { content: draft.trim() });
    setEditingId(undefined);
    await reloadMemories();
  };

  return (
    <div className="settings">
      <section>
        <h3>How memory works</h3>
        <p className="muted">
          Recent turns, a short summary and a small set of approved facts are sent with each new message. Memories are
          stored locally with their source and can be edited or deleted at any time. Nothing here is treated as
          verified truth by the AI, and nothing is stored for temporary chats.
        </p>
        <div className="row">
          <label>
            Mode
            <select
              value={settings.memoryMode}
              onChange={(event) => void updateSettings({ memoryMode: event.target.value as typeof settings.memoryMode })}
            >
              <option value="auto_review">Save automatically, review later</option>
              <option value="manual">Ask me before saving</option>
              <option value="disabled">Off</option>
            </select>
          </label>
        </div>
      </section>

      <section>
        <h3>Saved memories ({visible.length})</h3>
        {visible.length === 0 && <p className="muted">Nothing saved yet.</p>}
        <ul className="memories">
          {visible.map((memory) => (
            <li key={memory.id} className={memory.status !== 'active' ? 'muted' : ''}>
              {editingId === memory.id ? (
                <div className="row">
                  <input value={draft} onChange={(event) => setDraft(event.target.value)} />
                  <button type="button" onClick={() => void saveEdit(memory)}>
                    Save
                  </button>
                  <button type="button" onClick={() => setEditingId(undefined)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <p>{memory.content}</p>
                  <span className="muted">
                    {memory.category} · {memory.scope} scope · confidence {memory.confidence.toFixed(2)} · saved{' '}
                    {memory.createdAt.slice(0, 10)}
                    {memory.sourceMessageId ? ` · from message ${memory.sourceMessageId.slice(-6)}` : ''}
                    {memory.status === 'disabled' ? ' · disabled' : ''}
                    {memory.status === 'superseded' ? ' · replaced by a newer fact' : ''}
                  </span>
                  <div className="chiprow">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(memory.id);
                        setDraft(memory.content);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void setMemoryStatus(memory.id, memory.status === 'disabled' ? 'active' : 'disabled')
                      }
                    >
                      {memory.status === 'disabled' ? 'Enable' : 'Disable'}
                    </button>
                    <button type="button" className="danger" onClick={() => void deleteMemory(memory.id)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
