import { useCallback, useEffect, useRef, useState } from 'react'
import { useWakeWord } from './useWakeWord.js'
import { getWakeWord, setWakeWord } from '../lib/wakePhrase.js'
import { generateTitle } from '../lib/chatTitle.js'

const createId = (prefix = 'msg') => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const WAKE_ERRORS = {
  __NO_SPEECH_API__: 'Wake word needs Chrome or Edge with speech recognition enabled.',
  __MIC_DENIED__: 'Microphone permission was denied — wake word cannot arm.',
  __MIC_MISSING__: 'No microphone found — wake word cannot arm.',
  __MIC_ERROR__: 'The microphone could not be opened for wake word.',
}

function getSpeechRecognition() {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

/**
 * ASTRA client: chat, SSE streaming, TTS, a robust one-shot microphone, and the
 * hands-free wake word ("Hey Astra …").
 *
 * Conversation history is NOT owned here — `useConversations` is the source of
 * truth. This hook resolves which conversation a turn belongs to, streams the
 * reply into exactly that conversation's assistant message, and lets the voice
 * stack ride on top of the same send path.
 */
export function useAstra({ chat }) {
  const [streamingIds, setStreamingIds] = useState([])
  const [status, setStatus] = useState(null)
  const [speaking, setSpeaking] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceEnabled, setVoiceEnabled] = useState(true)
  const [voiceState, setVoiceState] = useState('idle')
  const [voiceError, setVoiceError] = useState('')

  // Live mirror of the store: async send paths must not wait for a re-render.
  const chatRef = useRef(chat)
  chatRef.current = chat

  const recognitionRef = useRef(null)
  const recognitionGenerationRef = useRef(0)
  const recognitionActiveRef = useRef(false)
  const transcriptRef = useRef('')
  const submittedRef = useRef(false)

  // One controller per in-flight conversation — streams are isolated by id.
  const streamsRef = useRef(new Map())

  const anyStreaming = () => streamsRef.current.size > 0

  const abortAllStreams = useCallback(() => {
    for (const controller of streamsRef.current.values()) {
      try { controller.abort() } catch { /* already gone */ }
    }
  }, [])

  const speak = useCallback((text) => {
    const clean = String(text ?? '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 700)
    if (!clean || !voiceEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return

    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(clean)
    utterance.rate = 1.02
    utterance.pitch = 1.08

    const voices = window.speechSynthesis.getVoices()
    const preferred =
      voices.find((v) =>
        /Samantha|Serena|Victoria|Karen|Moira|Tessa|Fiona|Google UK English Female|Google US English|Microsoft Zira|Microsoft Aria|Microsoft Jenny/i.test(v.name),
      ) ||
      voices.find((v) => v.gender === 'female' && /^en(-|_)/i.test(v.lang)) ||
      voices.find((v) => /^en(-|_)/i.test(v.lang))
    if (preferred) utterance.voice = preferred

    utterance.onstart = () => {
      // Our own voice must never be read as input: the hook logs the phase and
      // useAstra's yield effect has already suspended recognition by now.
      if (import.meta.env?.DEV) console.log('[ASTRA VOICE] SPEAKING')
      setSpeaking(true)
    }
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(utterance)
  }, [voiceEnabled])

  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    setSpeaking(false)
  }, [])

  // A wake command that lands while this conversation is still streaming must
  // not vanish — queue it and run it as soon as the turn releases the pipe.
  const pendingRef = useRef('')
  const sendRef = useRef(null)

  const send = useCallback(async (text) => {
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return false

    // Resolve the target conversation *before* touching any stream state.
    let conversationId
    try {
      conversationId = await chatRef.current.ensureActiveForMessage(trimmed)
    } catch {
      setVoiceError('Could not open a conversation — is the backend running?')
      return false
    }

    // Exactly one stream per conversation; queue if this one is already busy.
    if (streamsRef.current.has(conversationId)) {
      pendingRef.current = trimmed
      return false
    }

    const controller = new AbortController()
    streamsRef.current.set(conversationId, controller)
    setStreamingIds((prev) => (prev.includes(conversationId) ? prev : [...prev, conversationId]))
    setVoiceState((prev) => (prev === 'listening' ? 'processing' : prev))

    // Optimistic local echo; the server persists the same messages.
    chatRef.current.appendMessage(conversationId, {
      id: createId('user'),
      conversationId,
      role: 'user',
      content: trimmed,
      status: 'complete',
    })
    const assistantId = createId('assistant')
    chatRef.current.appendMessage(conversationId, {
      id: assistantId,
      conversationId,
      role: 'assistant',
      content: '',
      status: 'streaming',
    })

    const patch = (patchBody) => chatRef.current.patchMessage(conversationId, assistantId, patchBody)

    // Declared outside the try so an abort can still save the partial reply.
    let buffer = ''
    let reply = ''
    let finished = false

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          message: trimmed,
          // Local, rule-based title for a first message (server may ignore it).
          proposedTitle: generateTitle(trimmed),
        }),
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`Backend returned ${res.status}`)

      const contentType = res.headers.get('content-type') ?? ''

      if (contentType.includes('application/json')) {
        const data = await res.json()
        if (data.cleared) {
          // "/clear": the store already dropped the messages.
          chatRef.current.replaceMessages(conversationId, [])
        } else if (data.reply) {
          patch({
            content: data.reply,
            status: 'complete',
            command: Boolean(data.command || data.action),
          })
          speak(data.reply)
        } else {
          patch({ content: '', status: 'complete' })
        }
        chatRef.current.applyMeta(conversationId, data.meta)
        return true
      }

      if (!res.body || typeof res.body.getReader !== 'function') {
        throw new Error('Streaming is not supported by this browser')
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (!finished) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const events = buffer.split(/\r?\n\r?\n/)
        buffer = events.pop() ?? ''

        for (const event of events) {
          const line = event.split(/\r?\n/).find((item) => item.startsWith('data: '))
          if (!line) continue
          const payload = line.slice(6).trim()
          if (payload === '[DONE]') {
            finished = true
            break
          }

          try {
            const parsed = JSON.parse(payload)
            if (parsed.token) {
              reply += parsed.token
              patch({ content: reply })
            } else if (parsed.event === 'meta') {
              // Title / ordering metadata published when the turn completes.
              chatRef.current.applyMeta(conversationId, parsed.meta)
            }
          } catch {
            // Ignore malformed SSE keep-alives without breaking the stream.
          }
        }
      }

      patch({ content: reply, status: 'complete' })
      if (reply.trim()) speak(reply)
      return true
    } catch (error) {
      if (error?.name === 'AbortError') {
        // Barge-in / switch-away: keep whatever already streamed, and settle
        // the placeholder so nothing stays stuck in "streaming".
        patch({ content: reply, status: 'interrupted' })
        return false
      }

      const fallback = error instanceof Error ? error.message : 'Unknown connection error'
      patch({
        content: `I lost the connection to my backend. ${fallback}`,
        status: 'error',
        error: true,
      })
      setVoiceError('Backend connection failed.')
      return false
    } finally {
      streamsRef.current.delete(conversationId)
      setStreamingIds((prev) => prev.filter((id) => id !== conversationId))
      setVoiceState((prev) => (prev === 'processing' && !anyStreaming() ? 'idle' : prev))
      const queued = pendingRef.current
      if (queued) {
        pendingRef.current = ''
        sendRef.current?.(queued)
      }
    }
  }, [speak])

  useEffect(() => { sendRef.current = send }, [send])

  /**
   * Clears the *active* conversation: messages go away, the conversation
   * stays. Distinct from deleting it (which lives in the sidebar).
   */
  const clearChat = useCallback(async () => {
    const conversationId = chatRef.current.activeId
    if (conversationId) {
      streamsRef.current.get(conversationId)?.abort()
      // Drop the agent-side memory too so "/clear" really starts fresh.
      fetch('/proxy/v1/session/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: conversationId }),
      }).catch(() => { /* bridge offline: local history still cleared */ })
    }
    pendingRef.current = ''

    if (recognitionRef.current) {
      recognitionActiveRef.current = false
      try { recognitionRef.current.abort() } catch { /* noop */ }
      recognitionRef.current = null
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()

    if (conversationId) {
      try {
        await chatRef.current.clearMessages(conversationId)
      } catch {
        setVoiceError('Could not clear this chat — is the backend running?')
      }
    }

    setListening(false)
    setSpeaking(false)
    setVoiceState('idle')
    setVoiceError('')
  }, [])

  const note = useCallback((text) => {
    const conversationId = chatRef.current.activeId
    chatRef.current.appendMessage(conversationId, {
      id: createId('note'),
      role: 'assistant',
      content: text,
      error: true,
      status: 'complete',
    }, { ephemeral: true })
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/status')
      .then((r) => {
        if (!r.ok) throw new Error(`Status ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (!cancelled) setStatus(data)
      })
      .catch(() => {
        if (!cancelled) setStatus({ provider: 'local', model: 'not loaded', online: false, note: 'Backend unavailable.' })
      })
    return () => { cancelled = true }
  }, [])

  const stopRecognition = useCallback((abort = true) => {
    const rec = recognitionRef.current
    recognitionActiveRef.current = false
    if (rec) {
      try {
        abort ? rec.abort() : rec.stop()
      } catch { /* noop */ }
    }
    recognitionRef.current = null
    setListening(false)
  }, [])

  const startListening = useCallback(async () => {
    const SR = getSpeechRecognition()
    if (!SR) {
      const message = 'Voice input needs Chrome or Edge with speech recognition enabled.'
      setVoiceError(message)
      setVoiceState('error')
      note(message)
      return
    }

    if (anyStreaming()) return

    if (recognitionActiveRef.current || recognitionRef.current) {
      stopRecognition(true)
      return
    }

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        permissionStream.getTracks().forEach((track) => track.stop())
      } catch (error) {
        const name = error?.name || 'unknown'
        const message = name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow microphone access for ASTRA and try again.'
          : name === 'NotFoundError'
            ? 'No microphone was found on this device.'
            : 'ASTRA could not access the microphone.'
        setVoiceError(message)
        setVoiceState('error')
        return
      }
    }

    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    setVoiceError('')
    setVoiceState('starting')
    transcriptRef.current = ''
    submittedRef.current = false
    recognitionActiveRef.current = true
    const generation = ++recognitionGenerationRef.current
    const recognition = new SR()

    recognition.continuous = false
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.lang = 'en-US'

    recognition.onstart = () => {
      if (!recognitionActiveRef.current || recognitionRef.current !== recognition || generation !== recognitionGenerationRef.current) return
      setListening(true)
      setVoiceState('listening')
    }

    recognition.onresult = (event) => {
      if (!recognitionActiveRef.current || recognitionRef.current !== recognition || generation !== recognitionGenerationRef.current) return

      let finalText = ''
      let interimText = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const piece = event.results[i][0]?.transcript ?? ''
        if (event.results[i].isFinal) finalText += piece
        else interimText += piece
      }

      if (finalText.trim()) transcriptRef.current = `${transcriptRef.current} ${finalText}`.trim()

      if (finalText.trim() && !submittedRef.current) {
        submittedRef.current = true
        recognitionActiveRef.current = false
        setListening(false)
        setVoiceState('processing')
        try { recognition.stop() } catch { /* noop */ }
        recognitionRef.current = null
        void send(transcriptRef.current)
      }
    }

    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition || generation !== recognitionGenerationRef.current) return
      const code = event.error || 'unknown'
      const messagesByCode = {
        'not-allowed': 'Microphone permission was denied. Allow microphone access for ASTRA and try again.',
        'service-not-allowed': 'Speech recognition is blocked by the browser. Check microphone and speech permissions.',
        'audio-capture': 'No working microphone was detected.',
        network: 'The browser speech service reported a network error.',
        'no-speech': 'I did not hear speech. Try the microphone again.',
        aborted: 'Voice input was cancelled.',
      }
      setVoiceError(messagesByCode[code] || `Voice input failed (${code}).`)
      if (code !== 'aborted') setVoiceState('error')
      setListening(false)
    }

    recognition.onend = () => {
      if (recognitionRef.current !== recognition || generation !== recognitionGenerationRef.current) return
      recognitionActiveRef.current = false
      recognitionRef.current = null
      setListening(false)
      setVoiceState((prev) => (prev === 'processing' ? prev : 'idle'))

      if (!submittedRef.current && transcriptRef.current.trim()) {
        submittedRef.current = true
        setVoiceState('processing')
        void send(transcriptRef.current)
      }
    }

    recognitionRef.current = recognition

    try {
      recognition.start()
    } catch (error) {
      recognitionActiveRef.current = false
      recognitionRef.current = null
      setListening(false)
      setVoiceState('error')
      setVoiceError(error?.message || 'The microphone could not be started.')
    }
  }, [note, send, stopRecognition])

  const toggleListening = useCallback(() => {
    if (recognitionActiveRef.current || listening) {
      stopRecognition(true)
      setVoiceState('idle')
      return
    }
    void startListening()
  }, [listening, startListening, stopRecognition])

  // ─── wake word ─────────────────────────────────────────────────────────
  // Real hands-free path: "Hey Astra …" arms a recognizer, captures one
  // command and feeds it through send(). It automatically yields while ASTRA
  // is speaking, the manual mic is live, or a reply is streaming, then
  // re-arms when the system is idle again.

  const wakeUserPausedRef = useRef(false)
  const wakeYieldedRef = useRef(false)
  const [wakeBlocked, setWakeBlocked] = useState('')

  // The matcher reads module state in wakePhrase.js, so a new word takes effect
  // on the very next utterance. This mirror just tells React to re-render the
  // labels when it changes.
  const [wakeWord, setWakeWordState] = useState(() => getWakeWord())
  const applyWakeWord = useCallback((value) => {
    const next = setWakeWord(value)
    setWakeWordState(next)
    return next
  }, [])

  const wake = useWakeWord({
    onCommand: (text) => {
      if (WAKE_ERRORS[text]) {
        // Fatal mic error sentinel from the hook — surface it, don't chat it.
        setVoiceError(WAKE_ERRORS[text])
        setVoiceState('error')
        setWakeBlocked(WAKE_ERRORS[text])
        return
      }
      if (text && text.trim()) {
        // Barge-in: a spoken command outranks whatever turn is still running.
        // Aborting clears the pipe (send() reports AbortError silently) and the
        // queued command runs as soon as the current turn releases it.
        abortAllStreams()
        void sendRef.current?.(text.trim())
      }
    },
    onWake: () => {
      // Barge-in: cut any TTS so the command is heard cleanly.
      if ('speechSynthesis' in window) window.speechSynthesis.cancel()
      setSpeaking(false)
    },
  })

  // Only yield the wake mic while audio is actually coming out of the speakers
  // (or the manual mic is dictating). Text streaming/thinking must NOT mute it —
  // a turn can run for minutes, and a wake word that goes dead for minutes
  // reads as "the assistant is broken".
  const wakeBusy = speaking || listening

  useEffect(() => {
    if (!wake.active) {
      wakeYieldedRef.current = false
      return
    }
    if (wakeBusy && !wakeYieldedRef.current) {
      wakeYieldedRef.current = true
      wake.pause()
      return
    }
    if (!wakeBusy) {
      // Recover either from our own yield or from a command that finished
      // without ever setting busy (send() short-circuits on empty input).
      if (wakeYieldedRef.current || wake.state === 'PROCESSING') {
        wakeYieldedRef.current = false
        wake.resume()
      }
    }
  }, [wake.active, wake.state, wakeBusy, wake.pause, wake.resume])

  const toggleWake = useCallback(() => {
    if (wake.active) {
      wakeUserPausedRef.current = true
      wake.stop()
      return
    }
    wakeUserPausedRef.current = false
    wakeYieldedRef.current = false
    setWakeBlocked('')
    setVoiceState('idle')
    void wake.start()
  }, [wake])

  // Short chip label for the VOICE LINK row. Deliberately concrete: the chip
  // must never say "ARMED" while ASTRA is actually waiting for your command.
  const wakeStatus = (() => {
    if (!wake.active) {
      if (wakeBlocked) return 'MIC ERROR'
      return wakeUserPausedRef.current ? 'PAUSED' : 'STANDBY'
    }
    switch (wake.state) {
      case 'WAKE_LISTENING': return wake.listening ? 'LISTENING' : 'STARTING'
      case 'WAKE_DETECTED': return 'DETECTED'
      case 'COMMAND_LISTENING':
      case 'COMMAND_SILENCE_GRACE':
      case 'COMMAND_AWAIT_CONFIRM':
        return 'COMMAND'
      case 'PROCESSING': return 'WORKING'
      case 'ERROR': return 'MIC ERROR'
      default: return String(wake.state || '').toUpperCase()
    }
  })()

  /**
   * Authoritative display phase. TTS and hard mic errors outrank everything,
   * an in-flight command capture outranks a streaming reply, and every other
   * value comes straight out of the voice state machine — this is not inferred
   * from loose booleans.
   *
   * standby · wake-listening · wake-detected · command-listening ·
   * processing · speaking · error
   */
  const phase = (() => {
    if (wakeBlocked || wake.state === 'ERROR') return 'error'
    if (voiceState === 'error' && voiceError) return 'error'
    if (speaking) return 'speaking'
    switch (wake.state) {
      case 'WAKE_DETECTED':
        return 'wake-detected'
      case 'COMMAND_LISTENING':
      case 'COMMAND_SILENCE_GRACE':
      case 'COMMAND_AWAIT_CONFIRM':
        return 'command-listening'
      case 'PROCESSING':
        return 'processing'
      default:
        break
    }
    if (voiceState === 'processing' || streamingIds.length > 0) return 'processing'
    if (wake.active || listening) return 'wake-listening'
    return 'standby'
  })()

  useEffect(() => () => {
    abortAllStreams()
    recognitionActiveRef.current = false
    try { recognitionRef.current?.abort() } catch { /* noop */ }
    recognitionRef.current = null
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [abortAllStreams])

  const providerLabel = (() => {
    if (!status) return 'CORE CHECKING'
    if (!status.online) return 'CORE OFFLINE'
    return String(status.provider || 'CORE').toUpperCase()
  })()

  // Streaming state is scoped to the conversation you are looking at: a reply
  // still running in another chat must never make this chat look busy.
  const activeId = chat.activeId
  const streaming = Boolean(activeId) && streamingIds.includes(activeId)
  const thinking = streaming

  return {
    messages: chat.activeMessages,
    streaming,
    thinking,
    status,
    speaking,
    listening,
    voiceEnabled,
    voiceState,
    voiceError,
    providerLabel,
    setVoiceEnabled,
    toggleListening,
    stopSpeaking,
    send,
    clearChat,
    note,
    // wake word
    wakeActive: wake.active,
    wakeState: wake.state,
    wakeListening: wake.listening,
    wakeStatus,
    wakeError: wakeBlocked,
    wakeHeard: wake.heard,
    wakeWord,
    setWakeWord: applyWakeWord,
    toggleWake,
    // voice state machine (see useWakeWord STATES)
    phase,
    // live command capture
    commandListening: wake.commandListening,
    commandTranscript: wake.commandTranscript,
    commandCommitted: wake.commandCommitted,
    commandInterim: wake.commandInterim,
    commandElapsedMs: wake.commandElapsedMs,
    commandGraceMs: wake.commandGraceMs,
    commandSessionId: wake.commandSessionId,
    commandAwaitingConfirm: wake.commandAwaitingConfirm,
    submitVoiceCommand: wake.submitNow,
    cancelVoiceCommand: wake.cancelCommand,
  }
}
