/**
 * Command-capture policy: configuration + the “has the user finished speaking?”
 * rules.
 *
 * Pure module — no React, no DOM — so the decision that matters most (when do
 * we submit?) can be unit-tested in Node instead of guessed at in the browser.
 *
 * The design in one paragraph: waking ASTRA opens a *capture session*, not a
 * submission. Speech accumulates into that session. Silence only *starts a
 * timer*; the timer only fires a submission if the captured text reads like a
 * finished thought. A pause right after the wake word, or after “What is…”,
 * is a pause — not a command.
 */

/**
 * Tuning knobs for voice capture. Every duration is milliseconds.
 *
 * - COMMAND_MAX_DURATION_MS  safety ceiling for one command session. Reaching
 *                            it never auto-submits junk: no speech returns to
 *                            wake mode, unfinished speech asks the user.
 * - SILENCE_FINALIZE_MS      silence required before a *complete-looking*
 *                            transcript is submitted.
 * - POST_WAKE_GRACE_MS       minimum time after the wake word before any
 *                            auto-submit, so the beat you take between
 *                            “Astra …” and your question is never read as the
 *                            end of the command.
 * - RESTART_DELAY_MS         gap before a replacement recognizer is started.
 * - FRAGMENT_SILENCE_MS      silence after which an *unfinished-looking*
 *                            transcript is flagged for manual SEND/CANCEL
 *                            instead of being submitted or silently dropped.
 * - TICK_MS                  UI timer resolution.
 * - MAX_COMMAND_WORDS        hard cap on an accumulated transcript.
 */
export const VOICE_CONFIG = {
  COMMAND_MAX_DURATION_MS: 20000,
  SILENCE_FINALIZE_MS: 1800,
  POST_WAKE_GRACE_MS: 3000,
  RESTART_DELAY_MS: 300,
  FRAGMENT_SILENCE_MS: 6000,
  TICK_MS: 100,
  MAX_COMMAND_WORDS: 60,
}

/**
 * Tokens an utterance can NEVER end on: question words, prepositions,
 * conjunctions and verbs that demand an object. “is what”, “tell”, “about”
 * are always mid-thought.
 */
const NEVER_ENDS = new Set([
  // articles — always followed by a noun, so “what is the” is not an answer
  'the', 'a', 'an',
  // question words
  'what', 'why', 'how', 'who', 'whom', 'whose', 'when', 'where', 'which',
  'whatever', 'however', 'whether',
  // prepositions
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'into',
  'onto', 'over', 'under', 'between', 'through', 'during', 'before', 'after',
  'above', 'below', 'than', 'as', 'per', 'via', 'against', 'without', 'within',
  // conjunctions
  'and', 'or', 'but', 'if', 'then', 'because', 'while', 'although', 'though',
  'unless', 'since', 'so', 'therefore',
  // verbs that mean nothing without an object
  'tell', 'show', 'give', 'make', 'put', 'set', 'find', 'look', 'explain',
  'describe', 'repeat', 'please', 'just', 'like', 'still', 'also', 'very',
  'really', 'think', 'know', 'mean', 'wonder', 'suppose', 'reckon', 'decide',
  'check', 'help', 'need', 'want', 'ask', 'say', 'talk',
])

/**
 * Determiners that can stand alone as the complement of an inverted question —
 * “who is that”, “what is this”. Articles (“the”, “a”, “an”) are NOT here:
 * they always precede a noun, so “what is the” is always mid-sentence.
 */
const DETERMINERS = new Set([
  'this', 'that', 'these', 'those', 'some', 'any', 'each', 'every',
  'another', 'either', 'neither',
])

/**
 * Forms of “be”, pronouns and auxiliaries. They cannot end a plain sentence
 * (“tell me”) but routinely end an inverted one (“what time is it”).
 */
const SOFT = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'you', 'me', 'my', 'mine', 'your', 'yours', 'he', 'him', 'his', 'her',
  'hers', 'it', 'its', 'we', 'us', 'our', 'ours', 'they', 'them', 'their',
  'theirs', 'someone', 'somebody', 'anyone', 'anybody',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'do', 'does', 'did', 'have', 'has', 'had', 'gonna', 'wanna',
])

/** Sentence openers: question words and auxiliaries flip a sentence over, so
 *  its final word sits in subject position (“what time is it”). */
const OPENERS = new Set([
  'what', 'why', 'how', 'who', 'whom', 'whose', 'when', 'where', 'which',
  'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had',
])

/** Forms of “be”: the one thing that may precede a final pronoun/determiner
 *  in an inverted question — “who is that”, “what time is it”. */
const COPULA = new Set(['am', 'is', 'are', 'was', 'were'])

/**
 * Short utterances that ARE finished on their own. Checked before the length
 * rules so a genuine one-word command is never held back.
 */
const COMPLETE_SHORT = new Set([
  'stop', 'pause', 'play', 'resume', 'cancel', 'yes', 'no', 'okay', 'ok',
  'done', 'again', 'next', 'previous', 'prev', 'start', 'restart', 'quit',
  'exit', 'close', 'mute', 'unmute', 'louder', 'quieter', 'brighter',
  'thanks', 'confirm', 'continue', 'clear', 'refresh', 'home', 'back',
])

const TERMINAL_PUNCTUATION = /[.!?]$/

/**
 * Does the captured text read like something the user actually finished
 * saying? Used to decide between “wait a little longer” and “submit”.
 *
 * Not a grammar parser — a guard against the specific failure mode where
 * Chrome hands us a fragment (“is the”) the moment the command recognizer
 * joins a sentence already in progress. The bias is deliberate: when unsure,
 * answer *no*, because saying “unfinished” only costs a longer pause and a
 * visible Send button, while saying “finished” sends a garbage command.
 *
 * @param {string} text accumulated command transcript
 * @returns {boolean}
 */
export function isLikelyComplete(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return false

  // Ended with punctuation, or the whole thing is a known one-word command.
  if (TERMINAL_PUNCTUATION.test(trimmed)) return true
  const lower = trimmed.toLowerCase()
  if (COMPLETE_SHORT.has(lower)) return true

  const words = lower.replace(/[^a-z0-9'?]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return false

  // A two-letter token (“is”, “ah”, “um”) is never a finished command.
  if (trimmed.length < 4) return false

  const last = words[words.length - 1]
  if (NEVER_ENDS.has(last)) return false

  if (DETERMINERS.has(last) || SOFT.has(last)) {
    // These may only finish a sentence when they are the complement of a copula
    // in an inverted question: “who is that”, “what time is it”. “what do you”
    // and “what is the” are still mid-thought.
    const prev = words[words.length - 2]
    const complete = OPENERS.has(words[0]) && words.length >= 3 && COPULA.has(prev)
    if (!complete) return false
  }

  return true
}

/**
 * How long silence must hold before this transcript may be submitted.
 * Unfinished-looking text gets a much longer leash — and if it never
 * finishes, `isLikelyComplete` keeps it from being auto-submitted at all.
 *
 * @param {string} text accumulated command transcript
 * @returns {number} milliseconds
 */
export function silenceGraceFor(text) {
  return isLikelyComplete(text)
    ? VOICE_CONFIG.SILENCE_FINALIZE_MS
    : VOICE_CONFIG.FRAGMENT_SILENCE_MS
}

/** Collapse runs of whitespace without touching punctuation or casing. */
export function normalizeTranscript(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Append a newly finalized chunk to the accumulated transcript.
 *
 * Chrome re-hears words when a recognizer restarts, and the wake word's own
 * tail (“Astra, open YouTube”) is re-delivered by the command recognizer.
 * Overlapping text therefore *replaces* rather than duplicates; genuinely new
 * text appends.
 *
 * @param {string[]} committed previously finalized chunks
 * @param {string} chunk newly finalized chunk
 * @returns {string[]} the next committed list
 */
export function mergeFinal(committed, chunk) {
  const incoming = normalizeTranscript(chunk)
  if (!incoming) return committed

  const current = normalizeTranscript(committed.join(' '))
  if (current) {
    const a = incoming.toLowerCase()
    const b = current.toLowerCase()
    if (a.includes(b) || b.includes(a)) {
      return [a.length >= b.length ? incoming : current]
    }
  }

  const next = normalizeTranscript(`${current} ${incoming}`.trim())
  const words = next.split(' ')
  return [words.length > VOICE_CONFIG.MAX_COMMAND_WORDS
    ? words.slice(-VOICE_CONFIG.MAX_COMMAND_WORDS).join(' ')
    : next]
}

/** Live view of a session: everything finalized plus the in-progress word. */
export function transcriptOf(session) {
  if (!session) return ''
  const committed = normalizeTranscript(session.committed.join(' '))
  const interim = normalizeTranscript(session.interim || '')
  if (!committed) return interim
  if (!interim || committed.toLowerCase().includes(interim.toLowerCase())) return committed
  return `${committed} ${interim}`
}

/** MM:SS, for the big “how long have you been listening” readout. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 1.0s — for the “still listening” countdown. */
export function formatTenths(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`
}
