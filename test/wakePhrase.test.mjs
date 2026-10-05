/**
 * Unit tests for the wake-phrase matcher.
 * Run: npm --prefix frontend run test
 */
import assert from 'node:assert/strict'
import {
  detectWake,
  normalize,
  getWakeWord,
  setWakeWord,
  isValidWakeWord,
  DEFAULT_WAKE_WORD,
} from '../src/lib/wakePhrase.js'

const cases = [
  // [input, expectWake, expectCommand]
  ['hey astra', true, null],
  ['Hey Astra.', true, null],
  ['astra', true, null],
  ['hey astra open youtube', true, 'open youtube'],
  // Raw text after the wake word is kept as spoken: casing and punctuation
  // must survive into the command that gets submitted.
  ['Hey Astra, open YouTube', true, 'open YouTube'],
  ['Astra, stop.', true, 'stop.'],
  ['Astra, No, cancel.', true, 'No, cancel.'],
  ['astra what is the value of pi', true, 'what is the value of pi'],
  ['ASTRA play music', true, 'play music'],
  ['hey astro open youtube', true, 'open youtube'],      // STT mishear
  ['hey astra um what time is it', true, 'what time is it'], // filler stripped
  ['hey astra please open finder', true, 'open finder'],

  // must not fire
  ['the astronomy lecture was long', false, null],
  ['she walked astray again', false, null],
  ['open youtube', false, null],
  ['', false, null],
  ['   ', false, null],
  ['hey', false, null],           // wake word alone is not a command
  ['astronaut bob floated', false, null],
  ['hey astra!', true, null],
]

let passed = 0
for (const [input, wantWake, wantCommand] of cases) {
  const got = detectWake(input)
  assert.equal(got.isWake, wantWake, `isWake(${JSON.stringify(input)}) = ${got.isWake}, want ${wantWake}`)
  assert.equal(got.command, wantCommand, `command(${JSON.stringify(input)}) = ${JSON.stringify(got.command)}, want ${JSON.stringify(wantCommand)}`)
  passed++
}

// Normalization is idempotent and stable.
assert.equal(normalize('  Hey,   Astra!! '), 'hey astra')
assert.equal(normalize(normalize('Hey,   Astra!!')), normalize('Hey,   Astra!!'))
passed += 2

// --- configurable wake word -------------------------------------------------
assert.equal(getWakeWord(), DEFAULT_WAKE_WORD, 'starts on the default word')
assert.ok(isValidWakeWord('hey astra') && isValidWakeWord('computer'))
assert.ok(!isValidWakeWord('hi'), 'two-letter words would fire on everything')
assert.ok(!isValidWakeWord('one two three four'), 'too many words rejected')
passed += 5

const original = getWakeWord()
try {
  setWakeWord('Computer')
  assert.equal(getWakeWord(), 'computer', 'stored normalized')
  assert.equal(detectWake('hey computer open finder').command, 'open finder')
  assert.equal(detectWake('hey computer').isWake, true)
  assert.equal(detectWake('hey astra open youtube').isWake, false, 'old word no longer wakes')
  assert.equal(detectWake('computers are great').isWake, false, 'token match, not substring')
  passed += 5

  // Invalid input must not brick the recogniser.
  setWakeWord('x')
  assert.equal(getWakeWord(), 'computer', 'invalid value ignored')
  passed += 1
} finally {
  setWakeWord(original)
}
assert.equal(getWakeWord(), DEFAULT_WAKE_WORD, 'restored')
passed += 1

console.log(`wakePhrase: ${passed} assertions passed`)
