/**
 * Local, deterministic chat titling.
 *
 * No model, no network: a chat gets its name from its first meaningful
 * message using plain text rules. The goal is short, readable, meaningful
 * labels — never the whole first message, never "New Chat" once a real
 * message exists.
 *
 *   "What is the difference between SN1 and SN2?" → "SN1 vs SN2"
 *   "Explain quantum tunneling."                  → "Quantum Tunneling"
 *   "Help me redesign my website."                → "Website Redesign"
 */

export const DEFAULT_TITLE = 'New Chat'

const MAX_WORDS = 6
const MAX_LENGTH = 40

/** Words that carry no topic on their own (removed when anything remains). */
const STOPS = new Set([
  'my', 'your', 'our', 'their', 'its', 'this', 'that', 'these', 'those',
  'me', 'you', 'i', 'it', 'we', 'us', 'them', 'him', 'her',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'doing',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'have', 'has', 'had',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'because',
  'please', 'pls', 'kindly', 'just', 'very', 'really', 'some', 'any', 'something', 'anything',
])

/**
 * Grammatical glue: kept when it sits inside a phrase, lowercased by the
 * title casing, and dropped when it would open the title
 * ("a map of europe" → "Map of Europe").
 */
const MINOR = new Set([
  'a', 'an', 'the', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from',
  'into', 'about', 'to', 'vs', 'per', 'via',
])

/** "redesign my website" → "Website Redesign" (verb-last reads better as a label). */
const VERB_LAST = new Set([
  'redesign', 'rewrite', 'refactor', 'rebuild', 'rework', 'restructure', 'revamp',
  'reorganize', 'restore', 'review', 'renew',
])

/** Leading politeness / question / instruction scaffolding, stripped repeatedly. */
const LEADING_PATTERNS = [
  /^(?:hey|hi|hello|yo|ok(?:ay)?)\s+(?:there\s+)?(?:astra\s*,?\s*)/i,
  /^astra\s*,\s*/i,
  /^(?:please|pls|kindly)\b[\s,.:!?-]*/i,
  /^(?:can|could|would|will|shall)\s+(?:you\s+)?(?:just\s+)?(?:please\s+)?/i,
  /^(?:do\s+you\s+know\b\s*)/i,
  /^(?:i\s+(?:want|need|would\s+like|'d\s+like|am\s+looking\s+for|am\s+trying\s+to)|let'?s|help\s+me|need\s+help)\b[\s,.:!?-]*/i,
  /^(?:tell|give|show|find|get|fetch|read|send|play|remind)\s+(?:me\s+)?(?:out\s+)?(?:to\b\s*)?(?:about\b|how\b|what\b|why\b|when\b|where\b|who\b|which\b|if\b)?[\s,.:!?-]*/i,
  /^(?:teach|explain|describe|define|translate|summarize|compare|analy(?:ze|se)|investigate|research|debug|solve|answer)\b\s*(?:me\s+)?(?:about\b|how\b|what\b|why\b|when\b|where\b|who\b|which\b|if\b)?[\s,.:!?-]*/i,
  /^(?:walk\s+me\s+through|show\s+me\s+how\s+to)\b[\s,.:!?-]*/i,
  /^(?:what|who|when|where|why|how|which)(?:'s|\s+is|\s+are|\s+was|\s+were|\s+do|\s+does|\s+did|\s+can|\s+could|\s+will|\s+would|\s+to)?\b[\s,.:!?-]+/i,
  /^(?:about)\b[\s,.:!?-]+/i,
  // Leftover leading verbs ("who wrote X" → "X"): only once the rest has words.
  /^(?:wrote|written\s+by|made|created|built|designed|developed|fixed|authored|directed|composed|used|is|are|was|were|be|been)\b[\s,.:!?-]+/i,
  // Task verbs last, so their object becomes the topic.
  /^(?:write|create|build|make|design|develop|fix|improve|update|set\s+up|try\s+to|going\s+to)\b[\s,.:!?-]*/i,
]

const TRAILING_NOISE = /[\s,.:;!?'"`)\]}»”]+$/g

function cleanWords(text) {
  return text
    .replace(/[*_`#>~|[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

function stripLeading(text) {
  let value = text
  for (let pass = 0; pass < 8; pass += 1) {
    const before = value
    for (const pattern of LEADING_PATTERNS) {
      const next = value.replace(pattern, '')
      if (next !== value) value = next.trim()
    }
    if (value === before) break
  }
  return value
}

function titleCase(words) {
  return words
    .map((word, index) => {
      // Already an acronym / code-ish token: keep it untouched.
      if (/^[A-Z0-9]+$/.test(word) && word.length <= 6) return word
      if (/[A-Z]/.test(word)) return word
      // Lowercase token with a digit reads like an acronym: sn1 → SN1.
      if (/\d/.test(word) && word.length <= 6) return word.toUpperCase()
      if (index > 0 && MINOR.has(word.toLowerCase())) return word.toLowerCase()
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function clip(text) {
  if (text.length <= MAX_LENGTH) return text
  const cut = text.slice(0, MAX_LENGTH)
  const boundary = cut.lastIndexOf(' ')
  return (boundary > 12 ? cut.slice(0, boundary) : cut).trim()
}

function vsMatch(text) {
  const difference = text.match(
    /\b(?:the\s+)?difference\s+between\s+(.+?)\s+and\s+(.+?)(?=[?.!,;]|$)/i,
  )
  if (difference) return [difference[1], difference[2]]

  const compare = text.match(/\bcompare\s+(.+?)\s+(?:and|with|to)\s+(.+?)(?=[?.!,;]|$)/i)
  if (compare) return [compare[1], compare[2]]

  return null
}

function operandTitle(word) {
  const parts = cleanWords(word)
    .map((part) => part.replace(TRAILING_NOISE, ''))
    .filter((part) => part && !STOPS.has(part.toLowerCase()))
    .slice(0, 3)
    .filter((part, index, all) => !(index === 0 && MINOR.has(part.toLowerCase()) && all.length > 1))
  if (parts.length === 0) return ''
  return titleCase(parts)
}

/**
 * Produces a short, human title for a conversation from its first message.
 * Always returns a non-empty string; falls back to "New Chat".
 */
export function generateTitle(rawMessage) {
  const raw = String(rawMessage ?? '').replace(/\s+/g, ' ').trim()
  if (!raw || !/[a-z0-9]/i.test(raw)) return DEFAULT_TITLE

  // "X vs Y" style comparisons collapse to the two things being compared.
  const versus = vsMatch(raw)
  if (versus) {
    const left = operandTitle(versus[0])
    const right = operandTitle(versus[1])
    if (left && right) return clip(`${left} vs ${right}`)
  }

  const stripped = stripLeading(raw.replace(TRAILING_NOISE, '')).replace(TRAILING_NOISE, '')
  const words = cleanWords(stripped)
  if (words.length === 0) return DEFAULT_TITLE

  const meaningful = words.filter((word) => !STOPS.has(word.toLowerCase()))
  let chosen = meaningful.length > 0 ? meaningful : words

  // "verb object" labels read better as "object verb".
  if (chosen.length >= 2 && VERB_LAST.has(chosen[0].toLowerCase())) {
    chosen = [chosen[1], chosen[0], ...chosen.slice(2)]
  }

  // Drop a leading glue word ("About the roman empire" → "Roman Empire").
  while (chosen.length > 1 && MINOR.has(chosen[0].toLowerCase())) chosen = chosen.slice(1)

  const title = clip(titleCase(chosen.slice(0, MAX_WORDS))).replace(TRAILING_NOISE, '')
  return title || DEFAULT_TITLE
}
