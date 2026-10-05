/**
 * Unit tests for command-capture policy: when does ASTRA decide the user has
 * finished speaking? This is the logic behind "it grabbed 'is' and submitted".
 * Run: npm --prefix frontend run test
 */
import assert from 'node:assert/strict'
import {
  VOICE_CONFIG,
  isLikelyComplete,
  silenceGraceFor,
  mergeFinal,
  normalizeTranscript,
  transcriptOf,
  formatElapsed,
  formatTenths,
} from '../src/lib/commandCapture.js'

let passed = 0
const ok = (value, message) => { assert.ok(value, message); passed++ }
const eq = (got, want, message) => { assert.equal(got, want, `${message} (got ${JSON.stringify(got)})`); passed++ }

// --- configuration (spec §17) -----------------------------------------------
eq(VOICE_CONFIG.COMMAND_MAX_DURATION_MS, 20000, 'COMMAND_MAX_DURATION_MS')
eq(VOICE_CONFIG.SILENCE_FINALIZE_MS, 1800, 'SILENCE_FINALIZE_MS')
eq(VOICE_CONFIG.POST_WAKE_GRACE_MS, 3000, 'POST_WAKE_GRACE_MS')
eq(VOICE_CONFIG.RESTART_DELAY_MS, 300, 'RESTART_DELAY_MS')

// --- fragments must never be treated as finished ----------------------------
// These are the exact strings the browser handed us before the fix.
for (const fragment of [
  '', ' ', 'is', 'is the', 'what', 'the', 'um', 'what is', 'tell me',
  'can you explain what', 'why do', 'open the', 'hey', 'a',
  'can you explain', 'do you think', 'what about', 'is the meaning of',
  'what is the', 'what do you', 'when is the', 'why would you',
]) {
  eq(isLikelyComplete(fragment), false, `fragment ${JSON.stringify(fragment)}`)
}

// --- short commands must still go through -----------------------------------
for (const command of ['stop', 'yes', 'no', 'open youtube', 'play music', 'mute', 'cancel']) {
  eq(isLikelyComplete(command), true, `short command ${JSON.stringify(command)}`)
}

// --- finished sentences ------------------------------------------------------
for (const sentence of [
  'What is the meaning of life?',
  'what is the meaning of life',
  'No, cancel.',
  'Astra, stop.',
  'Can you explain why the sky is blue?',
  'Tell me what the difference is between SN1 and SN2.',
  'why do black holes evaporate',
  'open YouTube.',
  'what time is it',
  // Inverted questions may end on a pronoun or determiner — once they are
  // long enough to be one.
  'who is that',
  'how are you',
  'where are we',
  'what is this',
]) {
  eq(isLikelyComplete(sentence), true, `sentence ${JSON.stringify(sentence)}`)
}

// --- grace periods -----------------------------------------------------------
eq(silenceGraceFor('what is the meaning of life'), VOICE_CONFIG.SILENCE_FINALIZE_MS, 'complete → short grace')
eq(silenceGraceFor('is the'), VOICE_CONFIG.FRAGMENT_SILENCE_MS, 'fragment → long grace')

// --- accumulation ------------------------------------------------------------
eq(normalizeTranscript('  what   is \n the '), 'what is the', 'whitespace collapsed')

// Chrome hands us chunk by chunk; each new final appends, never replaces.
eq(mergeFinal([], 'what is').join(' '), 'what is', 'first chunk')
eq(mergeFinal(['what is'], 'the meaning').join(' '), 'what is the meaning', 'second chunk')
eq(mergeFinal(['what is', 'the meaning'], 'of life').join(' '), 'what is the meaning of life', 'third chunk')

// A recognizer restart re-hears what was already captured — overlap replaces
// instead of duplicating.
eq(mergeFinal(['what is the meaning of life'], 'what is the meaning of life').join(' '),
  'what is the meaning of life', 'identical re-hear does not duplicate')
eq(mergeFinal(['open YouTube'], 'open YouTube').join(' '), 'open YouTube', 'case-preserving dedupe')
eq(mergeFinal(['what is the meaning of life'], 'meaning of life').join(' '),
  'what is the meaning of life', 'tail re-hear absorbed by the longer text')
eq(mergeFinal(['what is'], 'the meaning of life').join(' '), 'what is the meaning of life',
  'a genuinely longer re-hear wins')

// Empty input is a no-op.
eq(mergeFinal(['what is'], '   ').join(' '), 'what is', 'blank chunk ignored')
eq(mergeFinal([], '').join(' '), '', 'empty session stays empty')

// --- live transcript ---------------------------------------------------------
eq(transcriptOf(null), '', 'no session')
eq(transcriptOf({ committed: [], interim: '' }), '', 'empty session')
eq(transcriptOf({ committed: ['what is'], interim: 'the meaning' }), 'what is the meaning',
  'committed + interim shown together')
eq(transcriptOf({ committed: ['what is the meaning of life'], interim: 'meaning of life' }),
  'what is the meaning of life', 'interim already inside committed is not repeated')
eq(transcriptOf({ committed: [], interim: 'What is' }), 'What is', 'interim only')

// --- formatting --------------------------------------------------------------
eq(formatElapsed(0), '00:00', 'elapsed 0')
eq(formatElapsed(3200), '00:03', 'elapsed 3.2s')
eq(formatElapsed(65000), '01:05', 'elapsed 65s')
eq(formatElapsed(-500), '00:00', 'elapsed clamps at zero')
eq(formatTenths(1000), '1.0s', 'grace countdown')
eq(formatTenths(0), '0.0s', 'grace countdown zero')

// --- punctuation survives into the submitted command ------------------------
eq(normalizeTranscript('No, cancel.'), 'No, cancel.', 'punctuation preserved')

ok(!isLikelyComplete(undefined), 'undefined is not complete')
ok(!isLikelyComplete(null), 'null is not complete')

console.log(`commandCapture: ${passed} assertions passed`)
