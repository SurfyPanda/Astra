import { useCallback, useEffect, useRef, useState } from 'react'
import { detectWake as detectWakePhrase } from '../lib/wakePhrase.js'
import {
  VOICE_CONFIG,
  formatElapsed,
  formatTenths,
  isLikelyComplete,
  mergeFinal,
  normalizeTranscript,
  silenceGraceFor,
  transcriptOf,
} from '../lib/commandCapture.js'

/**
 * ASTRA voice controller.
 *
 * Two independent jobs share one microphone, so there is exactly one
 * recognizer at a time and one authoritative state machine:
 *
 *     OFF
 *      │ start()
 *      ▼
 *   WAKE_LISTENING ──── say "Astra" ────► WAKE_DETECTED
 *      ▲                                       │ session opens
 *      │                                       ▼
 *      │                                COMMAND_LISTENING
 *      │                                  │           │
 *      │                 speech stops ────┘           │ speech resumes
 *      │                        ▼                     │
 *      │             COMMAND_SILENCE_GRACE ───────────┘
 *      │                        │ silence long enough, text finished
 *      │                        ▼
 *      │                    PROCESSING ── reply spoken ──► WAKE_LISTENING
 *      │                        │
 *      │        ceiling reached with unfinished text
 *      │                        ▼
 *      └──── CANCEL ──── COMMAND_AWAIT_CONFIRM ── SEND ──► PROCESSING
 *
 * Wake detection and command capture are deliberately separate: a wake opens a
 * *session*, speech accumulates into it, and silence only starts a timer. The
 * timer fires a submission only when the accumulated text reads like something
 * the user actually finished saying — a pause is never a command.
 */

export const STATES = {
  OFF: 'OFF',
  WAKE_LISTENING: 'WAKE_LISTENING',
  WAKE_DETECTED: 'WAKE_DETECTED',
  COMMAND_LISTENING: 'COMMAND_LISTENING',
  COMMAND_SILENCE_GRACE: 'COMMAND_SILENCE_GRACE',
  COMMAND_AWAIT_CONFIRM: 'COMMAND_AWAIT_CONFIRM',
  PROCESSING: 'PROCESSING',
  ERROR: 'ERROR',
}

const COMMAND_STATES = new Set([
  STATES.COMMAND_LISTENING,
  STATES.COMMAND_SILENCE_GRACE,
  STATES.COMMAND_AWAIT_CONFIRM,
])

export const isCommandState = (value) => COMMAND_STATES.has(value)

const DEV = import.meta.env?.DEV ?? false

function log(...args) {
  if (DEV) {
    console.log('[ASTRA VOICE]', ...args)
  }
}

export function useWakeWord({ onCommand, onWake }) {
  const [active, setActive] = useState(false)
  const [state, setState] = useState(STATES.OFF)
  const [listening, setListening] = useState(false)

  // Live capture readouts — they are what the sidebar timer/transcript render.
  const [heard, setHeard] = useState('')
  const [lastError, setLastError] = useState('')
  const [commandElapsedMs, setCommandElapsedMs] = useState(0)
  const [commandGraceMs, setCommandGraceMs] = useState(0)

  // --- single-recognizer ownership -----------------------------------------
  const recognitionRef = useRef(null)
  const generationRef = useRef(0)
  const restartTimerRef = useRef(null)
  const silenceTimerRef = useRef(null)
  const maxTimerRef = useRef(null)

  // --- the command session (the unit of capture) ---------------------------
  // Identified by a generation id so that a final result, an onend, or a
  // restart belonging to an already-submitted session can never fire twice.
  const sessionSeqRef = useRef(0)
  const sessionRef = useRef(null)

  // --- wake-mode transcript buffers ----------------------------------------
  // In continuous mode the result list keeps growing, so we only consume finals
  // we have not seen yet instead of re-reading history.
  const finalCountRef = useRef(0)
  const finalBufRef = useRef('')
  const interimRef = useRef('')
  // Chrome does not always commit a phrase. Debounce the interim text so an
  // uncommitted wake word is still seen, without acting on a growing stream.
  const wakeFallbackRef = useRef(null)

  const onCommandRef = useRef(onCommand)
  const onWakeRef = useRef(onWake)
  const activeRef = useRef(false)
  const stateRef = useRef(STATES.OFF)

  const debugState = useRef({
    lastEvent: null,
    lastError: null,
    lastTranscript: null,
    recognizerGeneration: 0,
    startedAt: null,
  })

  useEffect(() => {
    onCommandRef.current = onCommand
    onWakeRef.current = onWake
  })

  const updateDebug = useCallback((updates) => {
    if (DEV) Object.assign(debugState.current, updates)
  }, [])

  /**
   * The one place state may change, so every transition is logged and every
   * event handler reading `stateRef` sees the new value synchronously — the
   * React render pass is far too late to guard against a duplicate submit.
   */
  const transition = useCallback((next) => {
    if (stateRef.current === next) return
    stateRef.current = next
    setState(next)
    updateDebug({ lastEvent: `state:${next}` })
    log(next)
  }, [updateDebug])

  const clearWakeTimers = useCallback(() => {
    clearTimeout(restartTimerRef.current)
    clearTimeout(wakeFallbackRef.current)
    restartTimerRef.current = null
    wakeFallbackRef.current = null
  }, [])

  /** Close the current session: any pending capture timer dies with it. */
  const finishSession = useCallback(() => {
    clearTimeout(silenceTimerRef.current)
    clearTimeout(maxTimerRef.current)
    silenceTimerRef.current = null
    maxTimerRef.current = null
    sessionRef.current = null
  }, [])

  /**
   * Stop the current recognizer. Deliberately does NOT touch the command
   * session: pausing the mic mid-capture must not throw away what was heard.
   */
  const stopRecognizer = useCallback(() => {
    if (recognitionRef.current) {
      log(`stopping recognizer #${generationRef.current}`)
      try {
        recognitionRef.current.stop()
      } catch (e) {
        log('stop error (ignored):', e.message)
      }
      recognitionRef.current = null
    }
    clearWakeTimers()
    setListening(false)
    updateDebug({ listening: false })
  }, [clearWakeTimers, updateDebug])

  /**
   * Hand a captured command to the app exactly once, then park in PROCESSING
   * so the app can resume() us when its turn is over.
   */
  const submitSession = useCallback((id) => {
    const session = sessionRef.current
    if (!session) return false
    if (id != null && session.id !== id) {
      log(`stale session #${id} — current is #${session.id}`)
      return false
    }
    if (session.submitted) {
      log(`duplicate submit blocked for session #${session.id}`)
      return false
    }
    const text = transcriptOf(session)
    if (!text) return false

    session.submitted = true
    finishSession()
    stopRecognizer()
    setHeard(text)
    transition(STATES.PROCESSING)
    log(`COMMAND_SUBMITTED id=${session.id}`, text)
    onCommandRef.current?.(text)
    return true
  }, [finishSession, stopRecognizer, transition])

  /**
   * Silence ran out. Only submit if what we have reads as a finished thought;
   * otherwise surface SEND/CANCEL instead of guessing or silently dropping it.
   */
  const onSilenceElapsed = useCallback((id) => {
    silenceTimerRef.current = null
    const session = sessionRef.current
    if (!session || session.id !== id || session.submitted) return

    const text = transcriptOf(session)
    if (!isLikelyComplete(text)) {
      session.silenceUntil = 0
      log(`incomplete fragment held for confirmation id=${id}`, text)
      transition(STATES.COMMAND_AWAIT_CONFIRM)
      return
    }
    submitSession(id)
  }, [submitSession, transition])

  /**
   * Arm the silence timer for the current transcript.
   *
   * The deadline is the later of (last speech + grace) and (session start +
   * POST_WAKE_GRACE_MS) — the beat you take after "Astra …" before speaking is
   * a pause, never the end of the command.
   */
  const armSilenceTimer = useCallback((session) => {
    clearTimeout(silenceTimerRef.current)
    silenceTimerRef.current = null
    session.silenceUntil = 0

    const text = transcriptOf(session)
    if (!text) return

    const grace = silenceGraceFor(text)
    const fireAt = Math.max(
      session.lastActivityAt + grace,
      session.startedAt + VOICE_CONFIG.POST_WAKE_GRACE_MS,
    )
    session.silenceUntil = fireAt
    transition(STATES.COMMAND_SILENCE_GRACE)
    silenceTimerRef.current = setTimeout(
      () => onSilenceElapsed(session.id),
      Math.max(0, fireAt - Date.now()),
    )
    log(`silence-grace armed for ${Math.round(fireAt - Date.now())}ms`, text)
  }, [onSilenceElapsed, transition])

  /** COMMAND_MAX_DURATION_MS hit. Never submits junk: it either acts, returns
   *  to wake mode, or asks the user — it does not guess. */
  const onMaxElapsed = useCallback((id) => {
    maxTimerRef.current = null
    const session = sessionRef.current
    if (!session || session.id !== id || session.submitted) return

    const text = transcriptOf(session)
    log(`COMMAND_MAX id=${id}`, text || '(no speech)')

    if (!text) {
      // Nothing was said — the wake was a false start.
      finishSession()
      stopRecognizer()
      transition(STATES.WAKE_LISTENING)
      scheduleRestart(VOICE_CONFIG.RESTART_DELAY_MS)
      return
    }
    if (isLikelyComplete(text)) {
      submitSession(id)
      return
    }
    // Partial speech at the ceiling: stop the mic and let the user decide.
    session.stopped = true
    clearTimeout(silenceTimerRef.current)
    silenceTimerRef.current = null
    stopRecognizer()
    transition(STATES.COMMAND_AWAIT_CONFIRM)
    // scheduleRestart is declared later in this render; it is only read when
    // the callback runs, and must not appear in this deps array (TDZ).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishSession, stopRecognizer, submitSession, transition])

  /** Wake heard: open a capture session, optionally seeded with same-utterance text. */
  const beginCommandSession = useCallback((seed) => {
    finishSession()
    const now = Date.now()
    const session = {
      id: ++sessionSeqRef.current,
      committed: seed ? [normalizeTranscript(seed)] : [],
      interim: '',
      startedAt: now,
      lastActivityAt: now,
      silenceUntil: 0,
      submitted: false,
      awaitingConfirm: false,
      stopped: false,
    }
    sessionRef.current = session
    setCommandElapsedMs(0)
    setCommandGraceMs(0)
    setHeard(transcriptOf(session))
    log(`COMMAND_SESSION #${session.id} seed=${seed || '(none)'}`)
    transition(STATES.WAKE_DETECTED)
    maxTimerRef.current = setTimeout(
      () => onMaxElapsed(session.id),
      VOICE_CONFIG.COMMAND_MAX_DURATION_MS,
    )
  }, [finishSession, onMaxElapsed, transition])

  /**
   * Act on a wake phrase: tear down the wake recognizer, open a session, and
   * start capturing. The same-utterance case ("Astra, open YouTube") seeds the
   * session; the two-stage case ("Astra" … pause … "what is life") starts empty
   * and waits. Both then keep listening the same way.
   */
  const fireWake = useCallback((phrase) => {
    const { isWake, command } = detectWakePhrase(phrase)
    if (!isWake) return false
    onWakeRef.current?.()
    log('WAKE_DETECTED', command || '(command follows)')
    // Stop first: the old recognizer's onend must see a replaced recognitionRef
    // and go stale, not race the new command recognizer.
    stopRecognizer()
    beginCommandSession(command)
    startCommandListener()
    // startCommandListener is declared later in this render; referencing it
    // inside the callback (not in the deps array) avoids a TDZ error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopRecognizer, beginCommandSession])

  /**
   * Create and configure a new recognizer.
   *
   * `purpose` decides which state machine branch `onresult` feeds: 'wake'
   * searches for the wake word, 'command' accumulates into the open session.
   */
  const createRecognizer = useCallback((purpose) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      log('SpeechRecognition not available')
      return null
    }

    const generation = ++generationRef.current
    const rec = new SR()

    // continuous = true is deliberate: with false, Chrome tears the session
    // down after every utterance and there is a dead gap on every restart —
    // which is exactly where "Astra" used to get eaten.
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'

    // Fresh buffers: this recognizer indexes into its own result list.
    finalCountRef.current = 0
    finalBufRef.current = ''
    interimRef.current = ''
    clearTimeout(wakeFallbackRef.current)

    log(`created recognizer #${generation} for ${purpose}`)

    rec.onstart = () => {
      if (recognitionRef.current !== rec) return
      log(`#${generation} onstart`)
      setListening(true)
      setLastError('')
      if (purpose === 'command') {
        const session = sessionRef.current
        if (session && !session.submitted) {
          if (session.awaitingConfirm) {
            transition(STATES.COMMAND_AWAIT_CONFIRM)
          } else {
            transition(STATES.COMMAND_LISTENING)
            // A same-utterance wake ("Astra, open YouTube") arrives already
            // carrying text. Now that we are genuinely listening, start its
            // silence clock — nothing else would ever arm it.
            if (transcriptOf(session)) armSilenceTimer(session)
          }
        }
      }
      updateDebug({ listening: true, startedAt: Date.now() })
    }

    rec.onaudiostart = () => {
      if (recognitionRef.current !== rec) return
      updateDebug({ lastEvent: 'onaudiostart' })
    }
    rec.onsoundstart = () => {
      if (recognitionRef.current !== rec) return
      updateDebug({ lastEvent: 'onsoundstart' })
    }
    rec.onspeechstart = () => {
      if (recognitionRef.current !== rec) return
      updateDebug({ lastEvent: 'onspeechstart' })
    }

    rec.onresult = (event) => {
      if (recognitionRef.current !== rec) return

      const finals = []
      let interim = ''
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0]?.transcript ?? ''
        if (event.results[i].isFinal) finals.push(transcript)
        else interim += transcript
      }

      const current = stateRef.current

      // ---------------------------------------------------------------- wake
      if (purpose === 'wake') {
        if (finals.length > finalCountRef.current) {
          const fresh = finals.slice(finalCountRef.current).join(' ').trim()
          finalCountRef.current = finals.length
          if (fresh) {
            const words = `${finalBufRef.current} ${fresh}`.trim().split(' ')
            finalBufRef.current = (words.length > 20 ? words.slice(-20) : words).join(' ')
          }
        }
        const interimClean = interim.trim()
        interimRef.current = interimClean

        const monitor = interimClean && finalBufRef.current.includes(interimClean)
          ? finalBufRef.current
          : [finalBufRef.current, interimClean].filter(Boolean).join(' ').trim()
        if (monitor) {
          setHeard(monitor)
          updateDebug({ lastTranscript: monitor })
        }

        if (current !== STATES.WAKE_LISTENING) return
        const phrase = [finalBufRef.current, interimClean].filter(Boolean).join(' ').trim()
        if (!phrase) return

        clearTimeout(wakeFallbackRef.current)
        wakeFallbackRef.current = null

        // Prefer committed text — it is a complete phrase, so the command
        // cannot be cut off ("open yout…").
        if (fireWake(finalBufRef.current)) return

        // Chrome sometimes never commits the phrase. Debounce the interim text:
        // act on it only once it stops growing, so a real wake word is neither
        // dropped nor truncated mid-word.
        if (interimClean) {
          wakeFallbackRef.current = setTimeout(() => {
            wakeFallbackRef.current = null
            if (!activeRef.current) return
            if (stateRef.current !== STATES.WAKE_LISTENING) return
            fireWake(phrase)
          }, 800)
        }
        return
      }

      // ------------------------------------------------------------- command
      const session = sessionRef.current
      if (!session || session.submitted || !isCommandState(current)) return

      let changed = false
      if (finals.length > finalCountRef.current) {
        const fresh = finals.slice(finalCountRef.current)
        finalCountRef.current = finals.length
        for (const chunk of fresh) {
          const before = normalizeTranscript(session.committed.join(' '))
          session.committed = mergeFinal(session.committed, chunk)
          const after = normalizeTranscript(session.committed.join(' '))
          if (after !== before) {
            changed = true
            log(`final="${after}"`)
          }
        }
      }

      const interimClean = interim.trim()
      if (interimClean !== session.interim) {
        session.interim = interimClean
        changed = true
      }

      // Speech is arriving, even if it only re-confirms text we already hold —
      // that still counts as the user talking, so it re-arms the silence clock.
      // (A same-utterance wake reaches this with an identical re-hear, and
      // returning early here would leave the session with no timer at all.)
      session.lastActivityAt = Date.now()
      session.awaitingConfirm = false
      session.silenceUntil = 0
      if (changed) transition(STATES.COMMAND_LISTENING)
      const live = transcriptOf(session)
      if (changed) {
        setHeard(live)
        updateDebug({ lastEvent: 'onresult', lastTranscript: live })
        if (interimClean) log(`interim="${live}"`)
      }
      armSilenceTimer(session)
    }

    rec.onspeechend = () => {
      if (recognitionRef.current !== rec) return
      updateDebug({ lastEvent: 'onspeechend' })
    }
    rec.onsoundend = () => {
      if (recognitionRef.current !== rec) return
      updateDebug({ lastEvent: 'onsoundend' })
    }
    rec.onaudioend = () => {
      if (recognitionRef.current !== rec) return
      updateDebug({ lastEvent: 'onaudioend' })
    }

    rec.onerror = (event) => {
      if (recognitionRef.current !== rec) return
      log(`#${generation} onerror:`, event.error)
      updateDebug({ lastEvent: 'onerror', lastError: event.error })
      setLastError(event.error)

      const error = event.error
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(error)) {
        log('fatal error:', error)
        finishSession()
        stopRecognizer()
        transition(STATES.ERROR)
        setActive(false)
        activeRef.current = false
        if (error === 'not-allowed' || error === 'service-not-allowed') {
          onCommandRef.current?.('__MIC_DENIED__')
        } else if (error === 'audio-capture') {
          onCommandRef.current?.('__MIC_MISSING__')
        }
      }
      // no-speech / aborted / network: recover via onend.
    }

    rec.onend = () => {
      if (recognitionRef.current !== rec) return
      // A session can die on its own (mic dropped, network hiccup). Clear the
      // ref so resume()/restart don't think a dead recognizer is still alive.
      recognitionRef.current = null
      setListening(false)
      updateDebug({ lastEvent: 'onend' })
      log(`#${generation} onend, state=${stateRef.current}, active=${activeRef.current}`)

      if (!activeRef.current) return

      if (purpose === 'command') {
        const session = sessionRef.current
        // Chrome ends the recognizer even while the user is mid-sentence.
        // Restart it — the session object (transcript, timers, id) survives,
        // so the command session stays logically continuous.
        if (session && !session.submitted && !session.stopped && !recognitionRef.current) {
          if (Date.now() < session.startedAt + VOICE_CONFIG.COMMAND_MAX_DURATION_MS) {
            log(`command recognizer ended early — restarting, transcript preserved`)
            scheduleCommandRestart()
            return
          }
        }
        return
      }

      if (stateRef.current === STATES.WAKE_LISTENING) {
        scheduleRestart(VOICE_CONFIG.RESTART_DELAY_MS)
      }
      // PROCESSING: don't restart yet (the app will call resume).
      // scheduleRestart/scheduleCommandRestart are declared later in this
      // render and only read when the callback runs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }

    return rec
  }, [detectWakePhrase, stopRecognizer, updateDebug, transition, finishSession, fireWake, armSilenceTimer])

  /** Start the wake listener (looking for the configured wake word). */
  const startWakeListener = useCallback(() => {
    if (recognitionRef.current) stopRecognizer()
    // Never let a wake listener trample a command that is still being captured.
    const session = sessionRef.current
    if (session && !session.submitted) return false

    log('starting wake listener')
    transition(STATES.WAKE_LISTENING)

    const rec = createRecognizer('wake')
    if (!rec) {
      transition(STATES.ERROR)
      onCommandRef.current?.('__NO_SPEECH_API__')
      return false
    }

    recognitionRef.current = rec
    try {
      rec.start()
      return true
    } catch (e) {
      log('start failed:', e.message)
      transition(STATES.ERROR)
      recognitionRef.current = null
      return false
    }
  }, [createRecognizer, stopRecognizer, transition])

  /** Start (or transparently restart) the command listener for an open session. */
  const startCommandListener = useCallback(() => {
    const session = sessionRef.current
    if (!activeRef.current || !session || session.submitted || session.stopped) return
    if (recognitionRef.current) return

    log(`starting command listener for session #${session.id}`)
    const rec = createRecognizer('command')
    if (!rec) {
      finishSession()
      transition(STATES.WAKE_LISTENING)
      scheduleRestart(VOICE_CONFIG.RESTART_DELAY_MS)
      return
    }
    recognitionRef.current = rec
    try {
      rec.start()
    } catch (e) {
      log('command start failed:', e.message)
      finishSession()
      transition(STATES.WAKE_LISTENING)
      scheduleRestart(VOICE_CONFIG.RESTART_DELAY_MS)
    }
    // scheduleRestart is declared later in this render; it is only read when
    // the callback runs, and must not appear in this deps array (TDZ).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRecognizer, finishSession, transition])

  const scheduleRestart = useCallback((delay) => {
    clearTimeout(restartTimerRef.current)
    restartTimerRef.current = setTimeout(() => {
      if (activeRef.current && stateRef.current === STATES.WAKE_LISTENING && !sessionRef.current) {
        startWakeListener()
      }
    }, delay)
  }, [startWakeListener])

  const scheduleCommandRestart = useCallback((delay = VOICE_CONFIG.RESTART_DELAY_MS) => {
    clearTimeout(restartTimerRef.current)
    restartTimerRef.current = setTimeout(() => {
      if (!activeRef.current) return
      const session = sessionRef.current
      if (!session || session.submitted || session.stopped) return
      if (recognitionRef.current) return
      startCommandListener()
    }, delay)
  }, [startCommandListener])

  // --- public API -----------------------------------------------------------

  const start = useCallback(async () => {
    log('START requested')
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      onCommandRef.current?.('__NO_SPEECH_API__')
      return
    }

    // Request microphone permission upfront (bounded — a missing/blocked mic
    // must not leave wake mode hanging forever).
    try {
      const mediaPromise = navigator.mediaDevices.getUserMedia({ audio: true })
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 10_000),
      )
      const stream = await Promise.race([mediaPromise, timeoutPromise])
      stream.getTracks().forEach((t) => t.stop())
      log('microphone permission granted')
    } catch (e) {
      log('microphone permission failed:', e.name, e.message)
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
        onCommandRef.current?.('__MIC_DENIED__')
      } else if (e.name === 'NotFoundError') {
        onCommandRef.current?.('__MIC_MISSING__')
      } else {
        onCommandRef.current?.('__MIC_ERROR__')
      }
      return
    }

    finishSession()
    setActive(true)
    activeRef.current = true

    const success = startWakeListener()
    if (!success) {
      setActive(false)
      activeRef.current = false
    }
  }, [finishSession, startWakeListener])

  const stop = useCallback(() => {
    log('STOP requested')
    setActive(false)
    activeRef.current = false
    finishSession()
    stopRecognizer()
    setHeard('')
    setLastError('')
    setCommandElapsedMs(0)
    setCommandGraceMs(0)
    transition(STATES.OFF)
  }, [finishSession, stopRecognizer, transition])

  /**
   * Pause (TTS started, or the manual mic took over).
   *
   * The command session is deliberately left alive: pausing the mic must not
   * discard a half-finished sentence. Only the silence timer stops, since no
   * speech can be arriving while we are not listening.
   */
  const pause = useCallback(() => {
    log('PAUSE requested')
    if (!activeRef.current) return
    stopRecognizer()
    clearTimeout(silenceTimerRef.current)
    silenceTimerRef.current = null
    const session = sessionRef.current
    if (session) session.silenceUntil = 0
  }, [stopRecognizer])

  /**
   * Resume (TTS ended, or the manual mic was released).
   *
   * Also the recovery path after a command: capturing parks the machine in
   * PROCESSING, and without resetting that the wake listener never returns.
   */
  const resume = useCallback(() => {
    log(`RESUME requested active=${activeRef.current} state=${stateRef.current}`)
    if (!activeRef.current) return
    if (recognitionRef.current) return

    // An unfinished capture survives a pause — continue exactly that session.
    const session = sessionRef.current
    if (session && !session.submitted) {
      // Already flagged as unfinished: restore that decision rather than
      // silently re-arming a submit timer the user was just shown control over.
      if (session.awaitingConfirm || session.stopped) {
        transition(STATES.COMMAND_AWAIT_CONFIRM)
        if (!session.stopped) scheduleCommandRestart(0)
        return
      }
      log(`resuming capture of session #${session.id}`)
      const text = transcriptOf(session)
      if (text) armSilenceTimer(session)
      else transition(STATES.COMMAND_LISTENING)
      scheduleCommandRestart(0)
      return
    }

    if (stateRef.current !== STATES.WAKE_LISTENING) {
      transition(STATES.WAKE_LISTENING)
    }
    scheduleRestart(VOICE_CONFIG.RESTART_DELAY_MS)
  }, [armSilenceTimer, scheduleCommandRestart, scheduleRestart, transition])

  /** STOP & SEND — the user's explicit "yes, that's the whole command". */
  const submitNow = useCallback(() => {
    const session = sessionRef.current
    if (!session || session.submitted) return false
    log(`manual submit for session #${session.id}`)
    return submitSession(session.id)
  }, [submitSession])

  /** CANCEL — discard the current command and go back to listening for the wake word. */
  const cancelCommand = useCallback(() => {
    const session = sessionRef.current
    log('COMMAND_CANCELLED', session ? `#${session.id}` : '(no session)')
    if (session) session.submitted = true // block any late callback
    finishSession()
    stopRecognizer()
    setHeard('')
    setCommandElapsedMs(0)
    setCommandGraceMs(0)
    if (activeRef.current) {
      transition(STATES.WAKE_LISTENING)
      scheduleRestart(VOICE_CONFIG.RESTART_DELAY_MS)
    } else {
      transition(STATES.OFF)
    }
  }, [finishSession, stopRecognizer, scheduleRestart, transition])

  // Keep the refs the event handlers read in step with React state.
  useEffect(() => {
    activeRef.current = active
  }, [active])

  // Cleanup on unmount.
  useEffect(() => () => {
    activeRef.current = false
    stopRecognizer()
  }, [stopRecognizer])

  // Live listening timer: runs only while a command session is open, resets to
  // zero the moment capture ends.
  useEffect(() => {
    if (!isCommandState(state)) {
      setCommandElapsedMs(0)
      setCommandGraceMs(0)
      return undefined
    }
    const tick = () => {
      const session = sessionRef.current
      if (!session) return
      if (session.stopped) {
        // The ceiling released the microphone — freeze the readout where the
        // listening actually ended instead of counting an empty room.
        setCommandElapsedMs(Math.min(VOICE_CONFIG.COMMAND_MAX_DURATION_MS, Date.now() - session.startedAt))
        setCommandGraceMs(0)
        return
      }
      setCommandElapsedMs(Date.now() - session.startedAt)
      setCommandGraceMs(session.silenceUntil
        ? Math.max(0, session.silenceUntil - Date.now())
        : 0)
    }
    tick()
    const id = setInterval(tick, VOICE_CONFIG.TICK_MS)
    return () => clearInterval(id)
  }, [state])

  // Dev telemetry (spec §21): one object, refreshed every render.
  useEffect(() => {
    if (!DEV || typeof window === 'undefined') return
    const session = sessionRef.current
    const target = (window.__astraVoiceDebug ||= {})
    Object.assign(target, {
      state,
      wakeEnabled: active,
      recognitionActive: !!recognitionRef.current,
      commandSessionId: session?.id ?? null,
      listeningElapsedMs: commandElapsedMs,
      accumulatedTranscript: session ? normalizeTranscript(session.committed.join(' ')) : '',
      interimTranscript: session?.interim || '',
      awaitingConfirm: !!session?.awaitingConfirm,
      lastEvent: debugState.current.lastEvent,
      lastError: debugState.current.lastError || lastError || null,
      config: VOICE_CONFIG,
      formatElapsed,
      formatTenths,
    })
  })

  return {
    active,
    state,
    listening,
    heard,
    lastError,
    STATES,
    // command capture
    commandTranscript: sessionRef.current ? transcriptOf(sessionRef.current) : '',
    commandCommitted: sessionRef.current
      ? normalizeTranscript(sessionRef.current.committed.join(' '))
      : '',
    commandInterim: sessionRef.current?.interim || '',
    commandElapsedMs,
    commandGraceMs,
    commandSessionId: sessionRef.current?.id ?? null,
    commandAwaitingConfirm: !!sessionRef.current?.awaitingConfirm,
    commandListening: isCommandState(state),
    submitNow,
    cancelCommand,
    // lifecycle
    start,
    stop,
    pause,
    resume,
  }
}
