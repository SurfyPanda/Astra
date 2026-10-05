/**
 * Unit tests for the local chat-title generator (no LLM involved).
 * Run: npm --prefix frontend run test
 */
import assert from 'node:assert/strict'
import { generateTitle, DEFAULT_TITLE } from '../src/lib/chatTitle.js'

let passed = 0
const ok = (actual, expected, label) => {
  assert.equal(actual, expected, `${label}: expected "${expected}", got "${actual}"`)
  passed += 1
}

const properties = (input, label) => {
  const title = generateTitle(input)
  assert.ok(title.length > 0, `${label}: title must not be empty`)
  assert.ok(title.length <= 40, `${label}: title too long (${title.length})`)
  assert.ok(title.split(' ').length <= 6, `${label}: too many words`)
  assert.ok(!title.includes('\n'), `${label}: title must be single-line`)
  passed += 3
  return title
}

// --- Spec examples -------------------------------------------------------
ok(generateTitle('What is the difference between SN1 and SN2?'), 'SN1 vs SN2', 'spec example 1')
ok(generateTitle('Explain quantum tunneling.'), 'Quantum Tunneling', 'spec example 2')
ok(generateTitle('Help me redesign my website.'), 'Website Redesign', 'spec example 3')

// --- More natural phrasings ---------------------------------------------
ok(generateTitle('Tell me about the roman empire'), 'Roman Empire', 'tell me about')
ok(generateTitle('What is DNS?'), 'DNS', 'wh-question → acronym')
ok(generateTitle('can you explain how DNS works'), 'DNS Works', 'politeness + verb strip')
ok(generateTitle('How do I center a div in CSS'), 'Center a Div in CSS', 'how-do-i')
ok(generateTitle('compare React and Vue'), 'React vs Vue', 'compare → vs')
ok(generateTitle('please write a poem about dragons'), 'Poem about Dragons', 'write + glue word kept mid-title')
ok(generateTitle('hey astra open youtube'), 'Open Youtube', 'wake-style prefix')
ok(generateTitle('Astra, what time is it'), 'Time', 'greeting + question')
ok(generateTitle('build a chat app with websockets'), 'Chat App with Websockets', 'task verb stripped')

// --- Fallbacks -----------------------------------------------------------
ok(generateTitle(''), DEFAULT_TITLE, 'empty input')
ok(generateTitle('   '), DEFAULT_TITLE, 'whitespace input')
ok(generateTitle('!!! ???'), DEFAULT_TITLE, 'symbol-only input')
ok(generateTitle(null), DEFAULT_TITLE, 'null input')

// --- Properties ----------------------------------------------------------
const long = 'please explain to me in extreme detail exactly how the entire internet works ' +
  'from the cables under the ocean all the way to the browser rendering engine'
properties(long, 'very long message')
assert.notEqual(generateTitle(long), long.trim(), 'title is never the whole message')
passed += 1

const inputs = [
  'What is quantum tunneling',
  'Help me fix my build errors',
  'who wrote the silmarillion',
  'why is the sky blue',
  'summarize this article about black holes',
  'draft an email to my professor',
  'remind me to water the plants',
  'random gibberish asdf qwerty zxcv',
]
for (const input of inputs) properties(input, `property: ${input}`)

console.log(`chatTitle: ${passed} assertions passed`)
