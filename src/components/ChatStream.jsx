import { useEffect, useRef } from 'react'

export default function ChatStream({ messages, streaming, thinking, onSuggest }) {
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, thinking])

  return (
    <div className="chat-stream">
      {messages.length === 0 && (
        <div className="welcome-panel">
          <div className="welcome-orbit">✦</div>
          <div className="eyebrow">ASTRA</div>
          <h2>How can I help?</h2>
          <p>Ask a question, give a command, or use the microphone for a one-shot voice request.</p>
          <div className="welcome-actions">
            <button type="button" onClick={() => onSuggest('Explain how DNS works.')}>Explain DNS</button>
            <button type="button" onClick={() => onSuggest('What can you do?')}>What can you do?</button>
            <button type="button" onClick={() => onSuggest('/diagnostics')}>Check systems</button>
          </div>
        </div>
      )}

      <div className="message-list">
        {messages.map((message) => (
          <article key={message.id} className={`message message--${message.role}${message.command ? ' message--command' : ''}${message.error ? ' message--error' : ''}`}>
            <div className="message-meta">
              <span className="message-badge">{message.role === 'user' ? 'YOU' : 'ASTRA'}</span>
            </div>
            <div className="message-body">{message.content || (streaming && message.role === 'assistant' ? <span className="stream-placeholder"><i /><i /><i /></span> : '')}</div>
          </article>
        ))}
      </div>

      {thinking && messages.length > 0 && <div className="thinking-row"><span className="thinking-line" /><span>ASTRA is processing</span></div>}
      <div ref={endRef} />
    </div>
  )
}
