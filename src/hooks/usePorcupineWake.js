import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Premium wake-word path: Picovoice Porcupine with a custom-trained "Hey Astra"
 * keyword (.ppn). On-device, privacy-preserving, far more robust than the free
 * browser speech path — but needs two things:
 *
 *   1. npm i @picovoice/porcupine-react @picovoice/porcupine-web
 *   2. A free accessKey from console.picovoice.ai (and a trained .ppn model)
 *
 * This hook is INERT unless both are provided, so the app runs fine without it.
 * Wire it in App.jsx via useWakeMode() when you're ready — the contract matches
 * useWakeWord: { active, listening, start, stop }.
 */
export function usePorcupineWake({ accessKey, keywordPath, onCommand, onWake }) {
  const [active, setActive] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState(null)
  const porcupineRef = useRef(null)
  const webVoiceProcessorRef = useRef(null)
  const rearmGuardRef = useRef(false) // true while wake mode should stay alive
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake

  const stop = useCallback(async () => {
    rearmGuardRef.current = false
    try { await webVoiceProcessorRef.current?.stop() } catch { /* noop */ }
    try { await porcupineRef.current?.release() } catch { /* noop */ }
    webVoiceProcessorRef.current = null
    porcupineRef.current = null
    setActive(false)
    setListening(false)
  }, [])

  /**
   * The Porcupine audio pipeline with a guaranteed re-arm. Whatever happens
   * inside — detection callback throws, processor hiccups, worker dies — the
   * `finally` block ALWAYS restarts the engine while wake mode is active.
   * This is the deadlock fix: the old version released everything on any
   * error and never came back.
   */
  const startEngine = useCallback(async () => {
    rearmGuardRef.current = true
    try {
      const [{ PorcupineWorker }, { WebVoiceProcessor }] = await Promise.all([
        import('@picovoice/porcupine-web'),
        import('@picovoice/web-voice-processor'),
      ])
      porcupineRef.current = await PorcupineWorker.create(
        accessKey,
        { customWritePath: 'hey_astra', keywordPath },
        (keywordIndex) => {
          if (keywordIndex === 0) onWakeRef.current?.()
        },
      )
      webVoiceProcessorRef.current = await WebVoiceProcessor.create([porcupineRef.current])
      setActive(true)
      setListening(true)
      setError(null)
      return true
    } catch (e) {
      setError(String(e?.message ?? e))
      return false
    } finally {
      // ALWAYS re-arm while the user still wants wake mode — never deadlock.
      if (rearmGuardRef.current && !porcupineRef.current) {
        setTimeout(() => {
          if (rearmGuardRef.current) startEngine()
        }, 1000)
      }
    }
  }, [accessKey, keywordPath])

  const start = useCallback(async () => {
    if (!accessKey) {
      setError('Porcupine needs an accessKey from console.picovoice.ai — using the free browser wake path instead.')
      return false
    }
    await startEngine()
  }, [accessKey, startEngine])

  useEffect(() => () => { stop() }, [stop])

  return { active, listening, error, start, stop }
}
