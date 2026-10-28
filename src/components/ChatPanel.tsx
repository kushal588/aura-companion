import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAura } from '../app/store';

/**
 * Chat panel with composer and the Live mode bar (PLAN §3.1, §3.2, §8.2).
 *
 * Visible text is plain language only: turn metadata, emotions and any control
 * tags are stripped before they ever reach the transcript. The Live bar always
 * shows whether the microphone is active and offers one-tap mute and end.
 */
export function ChatPanel(): ReactNode {
  const messages = useAura((state) => state.messages);
  const sendMessage = useAura((state) => state.sendMessage);
  const interrupt = useAura((state) => state.interrupt);
  const status = useAura((state) => state.status);
  const live = useAura((state) => state.live);
  const captions = useAura((state) => state.captions);
  const sendLiveText = useAura((state) => state.sendLiveText);
  const setLiveMuted = useAura((state) => state.setLiveMuted);
  const stopLive = useAura((state) => state.stopLive);
  const speaking = useAura((state) => state.speaking);
  const ephemeral = useAura((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeConversationId)?.ephemeral,
  );

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const liveActive = live.state !== 'idle' && live.state !== 'disconnected';
  const transcript = useMemo(() => messages.filter((message) => message.role !== 'system_event'), [messages]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [transcript.length, captions.length]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    if (liveActive) {
      sendLiveText(text);
      return;
    }
    setBusy(true);
    try {
      await sendMessage(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat">
      <header className="chat__header">
        <h2>Chat</h2>
        {ephemeral && (
          <span className="pill pill--warn" title="Nothing in this chat is written to disk">
            temporary
          </span>
        )}
        {speaking && <span className="pill">AURA is speaking</span>}
      </header>

      <div className="chat__list" ref={listRef} role="log" aria-live="polite">
        {transcript.length === 0 && (
          <p className="muted chat__empty">
            Say hello, or press Live for a voice conversation. Everything stays on this device until you send it.
          </p>
        )}
        {transcript.map((message) => (
          <article key={message.id} className={`bubble bubble--${message.role} ${message.status === 'error' ? 'bubble--error' : ''}`}>
            <span className="bubble__role">{message.role === 'user' ? 'You' : 'AURA'}</span>
            {message.status === 'error' ? (
              <p>The AI service could not answer. Your message is saved; check the key in Settings and try again.</p>
            ) : (
              <p>{message.bodyText || (message.status === 'pending' ? '…' : '')}</p>
            )}
            <span className="bubble__meta">
              {message.modality === 'live' ? 'live' : 'text'}
              {message.status === 'pending' && message.modality === 'live' ? ' · provisional' : ''}
            </span>
          </article>
        ))}

        {liveActive && captions.length > 0 && (
          <section className="captions" aria-label="Live captions">
            {captions.slice(-8).map((caption) => (
              <p key={caption.id} className={`caption caption--${caption.role}`}>
                <strong>{caption.role === 'user' ? 'You' : 'AURA'}:</strong> {caption.text}
              </p>
            ))}
          </section>
        )}
      </div>

      {liveActive && (
        <div className="livebar" role="status">
          <span className={`dot dot--${live.state}`} aria-hidden="true" />
          <span>{live.state.replace(/_/g, ' ')}</span>
          <span className="muted">
            buffer {Math.round(live.bufferedMs)}ms
            {live.droppedChunks > 0 ? ` · dropped ${live.droppedChunks}` : ''}
          </span>
          <span className="spacer" />
          <button type="button" onClick={() => setLiveMuted(!live.micMuted)}>
            {live.micMuted ? 'Unmute mic' : 'Mute mic'}
          </button>
          <button type="button" className="danger" onClick={() => void stopLive()}>
            End Live
          </button>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="composer-input">
          Type a message
        </label>
        <textarea
          id="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder={liveActive ? 'Type to send into the Live conversation…' : 'Type a message…'}
        />
        {speaking && (
          <button type="button" onClick={interrupt} title="Stop the current reply">
            Stop
          </button>
        )}
        <button type="submit" disabled={busy || draft.trim().length === 0}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>

      <p className="chat__status">{status}</p>
    </div>
  );
}
