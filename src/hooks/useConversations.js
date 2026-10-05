import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chatApi } from '../lib/chatApi.js'
import { DEFAULT_TITLE, generateTitle } from '../lib/chatTitle.js'

const ACTIVE_KEY = 'astra.activeChat'
const DRAFT_KEY = '__draft__'
const EMPTY = []
const keyFor = (conversationId) => conversationId ?? DRAFT_KEY

/** Server message → UI message (stable id first, never an array index). */
const toUiMessage = (message) => {
  let command = false
  if (message.metadata) {
    try { command = Boolean(JSON.parse(message.metadata).command) } catch { /* legacy/no metadata */ }
  }
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    status: message.status ?? 'complete',
    command,
  }
}

const toSummary = (conversation) => ({
  id: conversation.id,
  title: conversation.title || DEFAULT_TITLE,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  pinned: Boolean(conversation.pinned),
  archived: Boolean(conversation.archived),
  titleManual: Boolean(conversation.titleManual),
  messageCount: conversation.messages?.length ?? conversation.messageCount ?? 0,
})

/** Pinned first, then most recently updated — stable across reloads. */
const sortConversations = (list) => [...list].sort((a, b) =>
  (Number(b.pinned) - Number(a.pinned)) ||
  (Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) ||
  String(b.id).localeCompare(String(a.id)))

const readSavedActive = () => {
  try { return localStorage.getItem(ACTIVE_KEY) } catch { return null }
}

const saveActive = (id) => {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch { /* private mode: selection just won't survive a refresh */ }
}

/**
 * The persistent conversation store.
 *
 * React state here is a *cache*: it mirrors what lives in the backend's
 * SQLite store. Everything reads back from `/api/chats`, so a refresh, a
 * browser restart or a dev-server rebuild can never lose a chat.
 */
export function useConversations() {
  const [conversations, setConversations] = useState([])
  const [messagesByConv, setMessagesByConv] = useState({})
  const [activeId, setActiveId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Synchronous mirrors: async flows (streaming sends) must see the current
  // conversation without waiting for a re-render.
  const conversationsRef = useRef(conversations)
  const activeIdRef = useRef(activeId)
  const loadedRef = useRef(new Set())
  // Conversations with a live turn in this tab. Their messages are owned by
  // the stream, so a background sync must never overwrite them.
  const busyRef = useRef(new Set())
  const syncingRef = useRef(false)

  const commitConversations = useCallback((nextOrFn) => {
    const next = typeof nextOrFn === 'function'
      ? nextOrFn(conversationsRef.current)
      : nextOrFn
    conversationsRef.current = next
    setConversations(next)
    return next
  }, [])

  const commitActive = useCallback((id) => {
    activeIdRef.current = id
    setActiveId(id)
    saveActive(id)
  }, [])

  /** Cache-first: a conversation already in memory never refetches on switch. */
  const fetchMessages = useCallback(async (id, options = {}) => {
    if (!id) return true
    if (!options.force && loadedRef.current.has(id)) return true
    try {
      const detail = await chatApi.get(id)
      const messages = (detail.messages ?? []).map(toUiMessage)
      loadedRef.current.add(id)
      // A turn may have started while the request was in flight: its messages
      // are authoritative in this tab, so drop the (now stale) snapshot.
      if (busyRef.current.has(id)) return true
      setMessagesByConv((prev) => ({ ...prev, [id]: messages }))
      commitConversations((prev) => prev.map((conversation) => (
        conversation.id === id
          ? {
              ...conversation,
              title: detail.title,
              pinned: Boolean(detail.pinned),
              archived: Boolean(detail.archived),
              titleManual: Boolean(detail.titleManual),
              messageCount: messages.length,
            }
          : conversation
      )))
      return true
    } catch {
      setError('That chat could not be loaded.')
      return false
    }
  }, [commitConversations])

  const loadMessages = useCallback((id) => fetchMessages(id), [fetchMessages])

  /** First paint: restore the last active chat, or the most recent one. */
  const bootstrap = useCallback(async () => {
    setLoading(true)
    try {
      const list = await chatApi.list()
      commitConversations(sortConversations(list.map(toSummary)))

      const saved = readSavedActive()
      const pick = (saved && list.find((item) => item.id === saved)) || list[0] || null
      if (pick) {
        activeIdRef.current = pick.id
        setActiveId(pick.id)
        await loadMessages(pick.id)
      } else {
        activeIdRef.current = null
        setActiveId(null)
      }
      setError('')
    } catch {
      setError('Chat history is unavailable — is the ASTRA backend running?')
    } finally {
      setLoading(false)
    }
  }, [commitConversations, loadMessages])

  useEffect(() => { void bootstrap() }, [bootstrap])

  /**
   * Self-heal when this window comes back to the front. Another window (or a
   * second tab) may have renamed, cleared, added to or deleted the chat we are
   * looking at — the server is authoritative, so re-sync from it. Live turns
   * in this tab are never touched (see busyRef).
   */
  const syncFromServer = useCallback(async () => {
    if (syncingRef.current) return
    syncingRef.current = true
    try {
      const list = await chatApi.list()
      const summaries = sortConversations(list.map(toSummary))
      commitConversations(summaries)

      const id = activeIdRef.current
      if (!id) return

      if (!summaries.some((item) => item.id === id)) {
        // Deleted from another window: land on a valid chat, never a ghost.
        const next = summaries[0]?.id ?? null
        loadedRef.current.delete(next)
        commitActive(next)
        if (next) await fetchMessages(next, { force: true })
        return
      }

      if (busyRef.current.has(id)) return
      await fetchMessages(id, { force: true })
    } catch {
      // Focus sync stays silent: a backend hiccup must not interrupt typing.
    } finally {
      syncingRef.current = false
    }
  }, [commitActive, commitConversations, fetchMessages])

  useEffect(() => {
    const onVisible = () => { if (!document.hidden) void syncFromServer() }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [syncFromServer])

  const select = useCallback(async (id) => {
    if (!id || activeIdRef.current === id) return
    commitActive(id)
    await loadMessages(id)
  }, [commitActive, loadMessages])

  /** "New Chat": persists an empty conversation immediately (never on refresh). */
  const create = useCallback(async (title) => {
    const conversation = await chatApi.create(title || DEFAULT_TITLE)
    const summary = toSummary(conversation)
    loadedRef.current.add(summary.id)
    setMessagesByConv((prev) => ({ ...prev, [summary.id]: [] }))
    commitConversations((prev) => sortConversations([
      summary,
      ...prev.filter((item) => item.id !== summary.id),
    ]))
    commitActive(summary.id)
    return summary
  }, [commitActive, commitConversations])

  /**
   * Guarantees a conversation exists before the first message of a session is
   * sent, and names it from that message while it is still untitled.
   * Returns the conversation id to use for this turn.
   */
  const ensureActiveForMessage = useCallback(async (text) => {
    const id = activeIdRef.current
    if (id) {
      const summary = conversationsRef.current.find((item) => item.id === id)
      if (summary && summary.messageCount === 0 && !summary.titleManual) {
        const title = generateTitle(text)
        if (title !== summary.title) {
          commitConversations((prev) => prev.map((item) => (
            item.id === id ? { ...item, title } : item
          )))
        }
      }
      return id
    }
    const created = await create(generateTitle(text))
    return created.id
  }, [commitConversations, create])

  const appendMessage = useCallback((conversationId, message, options = {}) => {
    const key = keyFor(conversationId)
    if (message?.role === 'assistant' && message.status === 'streaming') {
      busyRef.current.add(key)
    }
    setMessagesByConv((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), message] }))
    if (options.ephemeral || !conversationId) return
    commitConversations((prev) => prev.map((item) => (
      item.id === conversationId
        ? {
            ...item,
            messageCount: (item.messageCount ?? 0) + 1,
            updatedAt: new Date().toISOString(),
          }
        : item
    )))
  }, [commitConversations])

  const patchMessage = useCallback((conversationId, messageId, patch) => {
    if (patch?.status && patch.status !== 'streaming') {
      busyRef.current.delete(keyFor(conversationId))
    }
    setMessagesByConv((prev) => {
      const key = keyFor(conversationId)
      const list = prev[key]
      if (!list) return prev
      let changed = false
      const next = list.map((message) => {
        if (message.id !== messageId) return message
        changed = true
        return { ...message, ...patch }
      })
      return changed ? { ...prev, [key]: next } : prev
    })
  }, [])

  /** Replaces a conversation's cached messages wholesale (server is authoritative). */
  const replaceMessages = useCallback((conversationId, messages) => {
    if (!messages.length) busyRef.current.delete(keyFor(conversationId))
    setMessagesByConv((prev) => ({ ...prev, [keyFor(conversationId)]: messages }))
  }, [])

  /** Server metadata from a finished (or running) turn: title, order, count. */
  const applyMeta = useCallback((conversationId, meta) => {
    if (!conversationId || !meta) return
    commitConversations((prev) => {
      const exists = prev.some((item) => item.id === conversationId)
      if (!exists) return prev
      return sortConversations(prev.map((item) => (
        item.id === conversationId
          ? {
              ...item,
              title: meta.title ?? item.title,
              updatedAt: meta.updatedAt ?? item.updatedAt,
              messageCount: typeof meta.messageCount === 'number'
                ? meta.messageCount
                : item.messageCount,
            }
          : item
      )))
    })
  }, [commitConversations])

  const rename = useCallback(async (conversationId, title) => {
    const cleaned = String(title ?? '').trim()
    if (!cleaned) return false
    const updated = await chatApi.update(conversationId, { title: cleaned })
    commitConversations((prev) => sortConversations(prev.map((item) => (
      item.id === conversationId ? { ...item, ...toSummary({ ...item, ...updated }) } : item
    ))))
    return true
  }, [commitConversations])

  const remove = useCallback(async (conversationId) => {
    await chatApi.remove(conversationId)
    const remaining = conversationsRef.current.filter((item) => item.id !== conversationId)
    commitConversations(remaining)
    loadedRef.current.delete(conversationId)
    setMessagesByConv((prev) => {
      if (!(conversationId in prev)) return prev
      const copy = { ...prev }
      delete copy[conversationId]
      return copy
    })

    // Always land on a valid chat after a delete.
    if (activeIdRef.current === conversationId) {
      const next = remaining[0] ?? null
      if (next) {
        commitActive(next.id)
        await loadMessages(next.id)
      } else {
        commitActive(null)
      }
    }
  }, [commitActive, commitConversations, loadMessages])

  /** Clear messages, keep the conversation entity and its title. */
  const clearMessages = useCallback(async (conversationId) => {
    await chatApi.clear(conversationId)
    replaceMessages(conversationId, [])
    commitConversations((prev) => prev.map((item) => (
      item.id === conversationId
        ? { ...item, messageCount: 0, updatedAt: new Date().toISOString() }
        : item
    )))
  }, [commitConversations, replaceMessages])

  const sortedConversations = useMemo(() => sortConversations(conversations), [conversations])
  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeId) ?? null,
    [conversations, activeId],
  )
  const activeMessages = activeId
    ? (messagesByConv[activeId] ?? EMPTY)
    : (messagesByConv[DRAFT_KEY] ?? EMPTY)

  /** Local, instant search across the messages we already have cached. */
  const matchesContent = useCallback((conversationId, term) => {
    const list = messagesByConv[keyFor(conversationId)]
    if (!list || !term) return false
    const needle = String(term).toLowerCase()
    return list.some((message) => String(message.content ?? '').toLowerCase().includes(needle))
  }, [messagesByConv])

  return {
    conversations: sortedConversations,
    activeConversation,
    activeMessages,
    activeId,
    loading,
    error,
    select,
    create,
    remove,
    rename,
    clearMessages,
    ensureActiveForMessage,
    appendMessage,
    patchMessage,
    replaceMessages,
    applyMeta,
    matchesContent,
    reload: bootstrap,
  }
}
