import { useEffect, useState, type ReactNode } from 'react';
import { getStore, useAura } from '../app/store';
import { nowIso } from '../utils/ids';

/**
 * Conversation history (PLAN §3.3 screen 6, §9.5): search, resume, rename,
 * branch from any message, export and delete — without touching the original
 * conversation when branching.
 */
export function HistoryDialog(): ReactNode {
  const conversations = useAura((state) => state.conversations);
  const activeConversationId = useAura((state) => state.activeConversationId);
  const messages = useAura((state) => state.messages);
  const selectConversation = useAura((state) => state.selectConversation);
  const deleteConversation = useAura((state) => state.deleteConversation);
  const branchConversation = useAura((state) => state.branchConversation);
  const newConversation = useAura((state) => state.newConversation);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | undefined>();
  const [title, setTitle] = useState('');

  useEffect(() => {
    setEditingId(undefined);
  }, [activeConversationId]);

  const filtered = conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const rename = async (id: string): Promise<void> => {
    const store = getStore();
    if (!store) return;
    const conversation = await store.getConversation(id);
    if (!conversation) return;
    await store.saveConversation({ ...conversation, title: title.trim() || conversation.title, updatedAt: nowIso() });
    const updated = await store.listConversations(useAura.getState().activeCharacterId);
    useAura.setState({ conversations: updated });
    setEditingId(undefined);
  };

  return (
    <div className="settings">
      <section>
        <div className="row">
          <input placeholder="Search titles…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" onClick={() => void newConversation()}>
            New chat
          </button>
        </div>
        <p className="muted">
          Chats are stored locally. Tagged with the character and prompt version that produced them.
        </p>
      </section>

      <section>
        <h3>Chats ({filtered.length})</h3>
        <ul className="conversations">
          {filtered.map((conversation) => (
            <li key={conversation.id} className={conversation.id === activeConversationId ? 'active' : ''}>
              {editingId === conversation.id ? (
                <div className="row">
                  <input value={title} onChange={(event) => setTitle(event.target.value)} />
                  <button type="button" onClick={() => void rename(conversation.id)}>
                    Save
                  </button>
                </div>
              ) : (
                <>
                  <button type="button" className="link" onClick={() => void selectConversation(conversation.id)}>
                    {conversation.title}
                  </button>
                  <span className="muted">
                    updated {conversation.updatedAt.slice(0, 16).replace('T', ' ')}
                    {conversation.parentConversationId ? ' · branch' : ''}
                    {conversation.ephemeral ? ' · temporary' : ''}
                  </span>
                  <div className="chiprow">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(conversation.id);
                        setTitle(conversation.title);
                      }}
                    >
                      Rename
                    </button>
                    <button type="button" className="danger" onClick={() => void deleteConversation(conversation.id)}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      {messages.length > 0 && (
        <section>
          <h3>Branch from a message</h3>
          <p className="muted">
            Branching copies the conversation up to that point into a new chat. The original stays exactly as it is.
          </p>
          <ul className="conversations">
            {messages
              .filter((message) => message.role !== 'system_event')
              .slice(-8)
              .map((message) => (
                <li key={message.id}>
                  <span className="muted">{message.role === 'user' ? 'You' : 'AURA'}:</span>{' '}
                  {message.bodyText.slice(0, 80)}
                  <div className="chiprow">
                    <button type="button" onClick={() => void branchConversation(message.id)}>
                      Branch here
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
