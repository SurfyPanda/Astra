import { useEffect, useMemo, useRef, useState } from 'react'

/** "just now" · "12m" · "3h" · "Yesterday" · "Oct 3" — compact, never a full date. */
function formatWhen(iso) {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const diff = Date.now() - time
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 172_800_000) return 'Yest.'
  return new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * The conversation rail: new chat, search, the list itself, and the
 * per-row rename / delete controls. Everything here is presentation —
 * conversations come from the persistent store via props.
 */
export default function ChatSidebar({
  open,
  conversations,
  activeId,
  loading,
  error,
  statusLabel,
  canClear,
  matchesContent,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onClearMessages,
  onClose,
}) {
  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState(null)
  const [draft, setDraft] = useState('')
  const [confirmId, setConfirmId] = useState(null)
  const renameRef = useRef(null)

  const visible = useMemo(() => {
    const list = conversations.filter((item) => !item.archived)
    const term = query.trim().toLowerCase()
    if (!term) return list
    return list.filter((item) => (
      item.title.toLowerCase().includes(term) || matchesContent(item.id, term)
    ))
  }, [conversations, query, matchesContent])

  useEffect(() => {
    if (renamingId) renameRef.current?.focus()
  }, [renamingId])

  // Click-away cancels an open inline edit/confirm so rows never get stuck.
  useEffect(() => {
    if (!renamingId && !confirmId) return undefined
    const onPointerDown = (event) => {
      if (event.target.closest?.('.chat-row')) return
      setRenamingId(null)
      setConfirmId(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [renamingId, confirmId])

  const startRename = (item) => {
    setConfirmId(null)
    setRenamingId(item.id)
    setDraft(item.title)
  }

  const commitRename = () => {
    const title = draft.trim()
    setRenamingId(null)
    if (!title) return
    void onRename(renamingId, title)
  }

  const askDelete = (item) => {
    setRenamingId(null)
    setConfirmId(item.id)
  }

  const commitDelete = () => {
    const id = confirmId
    setConfirmId(null)
    if (id) void onDelete(id)
  }

  return (
    <aside className={`chat-sidebar ${open ? 'is-open' : ''}`} aria-label="Chat history">
      <div className="chat-sidebar-head">
        <button type="button" className="chat-new" onClick={onNew}>
          <span className="chat-new-glyph" aria-hidden="true">＋</span>
          <span>New chat</span>
        </button>
        <button type="button" className="chat-sidebar-close" onClick={onClose} aria-label="Close chat sidebar">
          ‹
        </button>
      </div>

      <div className="chat-search">
        <svg className="chat-search-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </svg>
        <input
          type="search"
          value={query}
          placeholder="Search chats"
          aria-label="Search chats"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button type="button" className="chat-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      <div className="chat-list" role="list">
        {loading && <div className="chat-list-note">Loading chats…</div>}

        {!loading && !error && visible.length === 0 && (
          <div className="chat-list-note">
            {query ? 'No chats match that.' : 'No chats yet — start one.'}
          </div>
        )}

        {visible.map((item) => {
          const active = item.id === activeId
          const renaming = renamingId === item.id
          const confirming = confirmId === item.id

          return (
            <div key={item.id} className={`chat-row ${active ? 'is-active' : ''}`}>
              {renaming ? (
                <div className="chat-rename">
                  <input
                    ref={renameRef}
                    value={draft}
                    maxLength={80}
                    aria-label="Chat name"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitRename() }
                      if (event.key === 'Escape') { event.preventDefault(); setRenamingId(null) }
                    }}
                  />
                  <div className="chat-rename-actions">
                    <button type="button" className="is-primary" onClick={commitRename}>Save</button>
                    <button type="button" onClick={() => setRenamingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : confirming ? (
                <div className="chat-confirm">
                  <span>Delete this chat permanently?</span>
                  <div className="chat-confirm-actions">
                    <button type="button" className="is-danger" onClick={commitDelete}>Delete</button>
                    <button type="button" onClick={() => setConfirmId(null)}>Keep</button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="chat-row-main"
                    onClick={() => onSelect(item.id)}
                    aria-current={active ? 'true' : undefined}
                    title={item.title}
                  >
                    <span className="chat-row-title">{item.title}</span>
                    <span className="chat-row-when">{formatWhen(item.updatedAt)}</span>
                  </button>
                  <div className="chat-row-actions">
                    <button
                      type="button"
                      title="Rename chat"
                      aria-label={`Rename ${item.title}`}
                      onClick={() => startRename(item)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      title="Delete chat"
                      aria-label={`Delete ${item.title}`}
                      onClick={() => askDelete(item)}
                    >
                      ⌫
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      {error && (
        <button type="button" className="chat-sidebar-error" onClick={() => window.location.reload()}>
          {error} — Retry
        </button>
      )}

      <div className="chat-sidebar-foot">
        <div className="chat-foot-row">
          <span className="chat-foot-label">Model</span>
          <span className="chat-foot-value">{statusLabel}</span>
        </div>
        <button
          type="button"
          className="chat-foot-row chat-foot-action"
          onClick={onClearMessages}
          disabled={!canClear}
          title="Clear messages in this chat (keeps the chat)"
        >
          <span className="chat-foot-label">Clear messages</span>
          <span className="chat-foot-value">⌫</span>
        </button>
      </div>
    </aside>
  )
}
