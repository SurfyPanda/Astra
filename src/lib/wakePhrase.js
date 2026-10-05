/**
 * Wake-phrase matching.
 *
 * Pure functions (no React, no browser) so they can be unit-tested and reused
 * by the Porcupine upgrade path. The wake word itself is configurable and lives
 * in module state so the UI can change it at runtime without re-wiring callers.
 *
 * Speech-to-text is noisy: the matcher works on normalized word tokens, accepts
 * a small set of mishearing variants for the default word, and strips filler
 * ("um", "please") between the wake word and the actual request.
 */

/** The wake word you get out of the box: say just “Astra”. */
export const DEFAULT_WAKE_WORD = 'astra'

/** Accepted as the default word when the recogniser mishears it. */
const VARIANTS = {
  astra: ['astra', 'astro', 'astre', 'astrah', 'asta'],
}

/** Filler the user leaves between the wake word and the actual request. */
const FILLERS = new Set([
  'um', 'uh', 'er', 'erm', 'hmm', 'hm', 'mm', 'mmm',
  'like', 'so', 'please', 'just', 'okay', 'ok', 'yeah', 'yep',
])

const STORAGE_KEY = 'astra.wakeword'

/** Lower-case, strip punctuation, collapse whitespace. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Read a saved wake word from localStorage, if the environment has one. */
function loadSaved() {
  try {
    const saved = normalize(globalThis?.localStorage?.getItem(STORAGE_KEY))
    if (isValidWakeWord(saved)) return saved
  } catch {
    // Non-browser environments (tests) or storage disabled — fall through.
  }
  return DEFAULT_WAKE_WORD
}

/** 1–3 words, each at least 3 characters: short enough to say, long enough not to fire on everything. */
export function isValidWakeWord(value) {
  const words = normalize(value).split(' ').filter(Boolean)
  if (words.length === 0 || words.length > 3) return false
  return words.every((w) => w.length >= 3)
}

let wakeWord = loadSaved()

/** Current wake word (normalized, space-separated). */
export function getWakeWord() {
  return wakeWord
}

/**
 * Set the wake word. Invalid input is ignored and the current word returned,
 * so a bad value can never leave the recogniser matching nothing.
 */
export function setWakeWord(value) {
  const next = normalize(value)
  if (isValidWakeWord(next)) wakeWord = next
  try {
    globalThis?.localStorage?.setItem(STORAGE_KEY, wakeWord)
  } catch {
    // Persisting is best-effort; the in-memory value is what matters.
  }
  return wakeWord
}

/** Does this token count as (a variant of) the configured wake word? */
function isWakeToken(token) {
  if (token === wakeWord) return true
  return (VARIANTS[wakeWord] ?? []).includes(token)
}

/**
 * Find the configured wake word.
 *
 * `raw` words are what the user actually said (case and punctuation intact);
 * `norm` are their normalized twins used for matching. They are index-aligned,
 * so a match in `norm` lets us slice the same span out of `raw` and keep the
 * original wording — “No, cancel.” must not become “no cancel”.
 *
 * @returns {number} index of the first wake word, or -1
 */
function indexOfWakeWord(raw, norm) {
  const target = wakeWord.split(' ')
  for (let i = 0; i <= norm.length - target.length; i++) {
    if (isWakeToken(norm[i])) {
      let matched = true
      for (let j = 1; j < target.length; j++) {
        if (norm[i + j] !== target[j]) { matched = false; break }
      }
      if (matched) return i
    }
  }
  return -1
}

/**
 * @param {string} transcript what the mic heard
 * @returns {{ isWake: boolean, command: string|null }} `command` is the raw
 *   text after the wake word, so natural casing and punctuation survive into
 *   the message ASTRA actually submits.
 */
export function detectWake(transcript) {
  const cleaned = normalize(transcript)
  if (!cleaned) return { isWake: false, command: null }

  const raw = String(transcript).trim().split(/\s+/)
  // Normalizing a single token is a lower-case + punctuation strip, so the two
  // arrays stay aligned even when a token normalizes to nothing.
  const norm = raw.map((token) => normalize(token))
  const index = indexOfWakeWord(raw, norm)
  if (index === -1) return { isWake: false, command: null }

  // Everything after the wake word is the request.
  const rest = raw.slice(index + wakeWord.split(' ').length)
  while (rest.length && FILLERS.has(normalize(rest[0]))) rest.shift()

  const command = rest.join(' ').trim()

  return {
    isWake: true,
    // Shorter than 3 characters is noise (“hey astra… um”), not a command.
    command: command.length > 2 ? command : null,
  }
}
