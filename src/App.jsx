import { useEffect, useMemo, useState } from 'react'
import AstraOrb from './components/AstraOrb.jsx'
import ChatStream from './components/ChatStream.jsx'
import ChatSidebar from './components/ChatSidebar.jsx'
import CommandBar from './components/CommandBar.jsx'
import { useAstra } from './hooks/useAstra.js'
import { useActivity } from './hooks/useActivity.js'
import { useConversations } from './hooks/useConversations.js'
import { isValidWakeWord } from './lib/wakePhrase.js'
import { formatElapsed, formatTenths } from './lib/commandCapture.js'
import './styles/orb.css'
import './styles/chat.css'
import './styles/controls.css'
import './styles/chatSidebar.css'

const QUICK_ACTIONS = [
  { label: 'System status', prompt: '/status' },
  { label: 'Run diagnostics', prompt: '/diagnostics' },
  { label: 'Who are you?', prompt: 'Who are you?' },
  { label: 'Create a test file', prompt: 'Create a file named astra-test.txt on my Desktop with the text "hello from astra".' },
]

const ACTIVITY_TONE = {
  tool: 'ok',
  'turn-start': 'warn',
  step: 'muted',
  error: 'bad',
  reset: 'muted',
  permission: 'ok',
}

/**
 * Human labels for the voice state machine's phases (useAstra.phase).
 * Kept concrete on purpose — "LISTENING FOR COMMAND", never "ARMED".
 */
const PHASE_LABEL = {
  standby: 'Standby',
  'wake-listening': 'Wake listening',
  'wake-detected': 'Wake detected',
  'command-listening': 'Listening for command',
  processing: 'Processing',
  speaking: 'Speaking',
  error: 'Microphone error',
}

export default function App() {
  const chat = useConversations()
  const astra = useAstra({ chat })
  const activity = useActivity(14)
  const [booting, setBooting] = useState(true)
  const [bootLine, setBootLine] = useState('INITIALIZING ASTRA CORE')
  const [bootProgress, setBootProgress] = useState(0)
  const [railOpen, setRailOpen] = useState(() => (
    typeof window === 'undefined' ? true : window.innerWidth > 900
  ))

  useEffect(() => {
    const lines = [
      'INITIALIZING ASTRA CORE',
      'LOADING INTERFACE',
      'CHECKING VOICE LINK',
      'MOUNTING CONTROL BUS',
      'ONLINE',
    ]
    let index = 0
    const timer = setInterval(() => {
      setBootLine(lines[index])
      setBootProgress(Math.round(((index + 1) / lines.length) * 100))
      index += 1
      if (index >= lines.length) {
        clearInterval(timer)
        setTimeout(() => setBooting(false), 450)
      }
    }, 270)
    return () => clearInterval(timer)
  }, [])

  const activeMode = useMemo(() => {
    if (astra.speaking) return 'speaking'
    // A command session in progress is the loudest fact about the mic: it wins
    // over a reply still streaming, because that is when the user is talking.
    if (astra.phase === 'command-listening' || astra.phase === 'wake-detected') return 'listening'
    if (astra.thinking || astra.streaming || astra.voiceState === 'processing' || astra.phase === 'processing') return 'thinking'
    // wakeListening is the real audio-in signal: while the wake mic is armed
    // and hearing you the orb must say so, not sit on "Ready".
    if (astra.listening || astra.wakeListening) return 'listening'
    return 'idle'
  }, [astra.listening, astra.speaking, astra.thinking, astra.streaming, astra.voiceState, astra.phase, astra.wakeListening])

  const coreStatus = !astra.status
    ? 'Checking core'
    : astra.status.online
      ? `${astra.status.provider || 'Core'} · ${astra.status.model || 'Ready'}`
      : 'Local core not loaded'

  // Header and sidebar always show the same name — both read the store.
  const conversationTitle = chat.activeConversation?.title || 'New chat'

  // Display form of the configured wake word ("astra" → "Astra").
  const wakeLabel = astra.wakeWord.replace(/\b[a-z]/g, (c) => c.toUpperCase())

  // Inline editor for the wake word — one source of truth, changed at runtime.
  const [editingWake, setEditingWake] = useState(false)
  const [wakeDraft, setWakeDraft] = useState('')
  const [wakeDraftError, setWakeDraftError] = useState('')

  const openWakeEditor = () => {
    setWakeDraft(astra.wakeWord)
    setWakeDraftError('')
    setEditingWake(true)
  }
  const saveWakeWord = () => {
    if (!isValidWakeWord(wakeDraft)) {
      setWakeDraftError('Use 1–3 words of at least 3 letters — short enough to say, long enough not to fire on every sentence.')
      return
    }
    astra.setWakeWord(wakeDraft)
    setWakeDraftError('')
    setEditingWake(false)
  }
  const cancelWakeEditor = () => {
    setWakeDraftError('')
    setEditingWake(false)
  }

  // The line under the orb must track what ASTRA is actually doing — a static
  // "Ready" while the mic is armed is what makes the wake word feel dead.
  const presenceCopy = (() => {
    if (astra.phase === 'error') return astra.wakeError || astra.voiceError || 'Microphone unavailable.'
    if (astra.speaking) return `Replying out loud. Say “${wakeLabel}” again once I finish.`
    if (astra.phase === 'command-listening') {
      return astra.commandTranscript
        ? 'Still listening — take your time. I submit only when you finish.'
        : `Heard “${wakeLabel}”. Take a breath, then ask your question.`
    }
    if (astra.phase === 'wake-detected') return `Heard “${wakeLabel}”. Listening for your command…`
    if (astra.phase === 'processing') {
      return (astra.thinking || astra.streaming)
        ? 'Running your request — tool calls are streaming into AGENT ACTIVITY below.'
        : 'Got it — sending your command to the agent now.'
    }
    if (astra.wakeActive && astra.wakeError) return astra.wakeError
    if (astra.wakeActive) return `Listening for “${wakeLabel}”. Say it, pause as long as you like, then ask.`
    if (astra.listening) return 'Microphone open — speak your request.'
    return 'Manual voice input is ready. Click the microphone, speak naturally, and ASTRA will handle one request at a time.'
  })()

  return (
    <div className="astra-app">
      {booting && (
        <div className="boot-screen" role="status">
          <div className="boot-mark"><span>✦</span></div>
          <div className="boot-name">ASTRA</div>
          <div className="boot-line">{bootLine}</div>
          <div className="boot-track"><span style={{ width: `${bootProgress}%` }} /></div>
          <div className="boot-meta">AUTONOMOUS SYSTEM TASK &amp; REASONING ASSISTANT</div>
        </div>
      )}

      <header className="topbar">
        <div className="topbar-left">
          <button
            type="button"
            className={`rail-toggle ${railOpen ? 'is-open' : ''}`}
            onClick={() => setRailOpen((value) => !value)}
            aria-label={railOpen ? 'Hide chat history' : 'Show chat history'}
            aria-expanded={railOpen}
            title={railOpen ? 'Hide chat history' : 'Show chat history'}
          >
            <span /><span /><span />
          </button>
          <div className="brand-lockup">
            <div className="brand-icon"><img src="/astra-mark.svg" alt="" /></div>
            <div>
              <div className="brand-title">ASTRA</div>
              <div className="brand-caption">personal intelligence interface</div>
            </div>
          </div>
        </div>

        <div className="topbar-right">
          <div className={`core-pill ${astra.status?.online ? 'is-online' : ''}`}>
            <span className="core-dot" />
            <span>{coreStatus}</span>
          </div>
          <div className="version-pill">V3 · LOCAL</div>
        </div>
      </header>

      <main className={`workspace ${railOpen ? 'has-chat-rail' : ''}`}>
        {railOpen && <div className="chat-scrim" onClick={() => setRailOpen(false)} aria-hidden="true" />}

        <ChatSidebar
          open={railOpen}
          conversations={chat.conversations}
          activeId={chat.activeId}
          loading={chat.loading}
          error={chat.error}
          statusLabel={coreStatus}
          canClear={Boolean(chat.activeId) && astra.messages.length > 0}
          matchesContent={chat.matchesContent}
          onSelect={(id) => {
            void chat.select(id)
            if (typeof window !== 'undefined' && window.innerWidth <= 900) setRailOpen(false)
          }}
          onNew={() => { void chat.create() }}
          onRename={(id, title) => void chat.rename(id, title)}
          onDelete={(id) => void chat.remove(id)}
          onClearMessages={() => { void astra.clearChat() }}
          onClose={() => setRailOpen(false)}
        />

        <aside className="sidebar">
          <div className="presence-card">
            <div className="presence-heading">
              <span className="eyebrow">PRESENCE</span>
              <span className={`presence-light presence-${activeMode}`} />
            </div>
            <AstraOrb listening={activeMode === 'listening'} thinking={activeMode === 'thinking'} speaking={activeMode === 'speaking'} />
            <div className={`presence-state presence-state--${activeMode} ${astra.phase === 'command-listening' ? 'presence-state--capture' : ''}`}>
              {PHASE_LABEL[astra.phase] || 'Ready'}
            </div>
            <p className="presence-copy">{presenceCopy}</p>

            {/* Live command capture: elapsed time, what has been assembled so
                far, and the explicit escape hatches. This is the panel that
                makes ASTRA look like she is waiting for you to finish. */}
            {astra.commandListening && (
              <div className="voice-capture" role="status" aria-live="polite">
                <div className="voice-capture-head">
                  <span className="voice-capture-state">
                    {astra.wakeState === 'COMMAND_AWAIT_CONFIRM' ? 'CONFIRM COMMAND' : 'LISTENING FOR COMMAND'}
                  </span>
                  <span className="voice-capture-timer">{formatElapsed(astra.commandElapsedMs)}</span>
                </div>
                <div className="voice-capture-hint">
                  {astra.wakeState === 'COMMAND_AWAIT_CONFIRM'
                    ? 'That sounds unfinished — send it anyway, or discard it.'
                    : astra.commandGraceMs > 0
                      ? `Still listening… ${formatTenths(astra.commandGraceMs)}`
                      : 'Speak your question…'}
                </div>
                {(astra.commandCommitted || astra.commandInterim) ? (
                  <div className="voice-capture-transcript" title="Accumulated command transcript">
                    <span className="voice-capture-prompt">›</span>
                    <span className="voice-capture-text">
                      {astra.commandCommitted}
                      {astra.commandInterim
                        ? <span className="voice-capture-live"> {astra.commandInterim}</span>
                        : null}
                    </span>
                  </div>
                ) : (
                  <div className="voice-capture-transcript voice-capture-transcript--empty">
                    <span className="voice-capture-prompt">›</span>
                    <span className="voice-capture-text voice-capture-text--muted">waiting for speech</span>
                  </div>
                )}
                <div className="voice-capture-actions">
                  <button
                    type="button"
                    className="voice-capture-send"
                    disabled={!astra.commandTranscript}
                    onClick={astra.submitVoiceCommand}
                  >
                    Send
                  </button>
                  <button type="button" className="voice-capture-cancel" onClick={astra.cancelVoiceCommand}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {astra.wakeActive && astra.wakeHeard && !astra.commandListening && (
              <p className="presence-heard" title="Last phrase heard by the wake mic">
                HEARD · “{astra.wakeHeard}”
              </p>
            )}
          </div>

          <div className="module-card">
            <div className="eyebrow">VOICE LINK</div>
            <div className="module-row">
              <span>Manual microphone</span>
              <span className="module-state ok">READY</span>
            </div>
            <button type="button" className="module-row module-row--action" onClick={astra.toggleWake}>
              <span>Wake word · “{wakeLabel}”</span>
              <span className={`module-state ${astra.wakeActive ? 'ok' : ''}`}>{astra.wakeStatus}</span>
            </button>
            <div className="module-hint">
              {astra.wakeActive
                ? 'Armed. It yields the mic while ASTRA speaks or a reply streams, then re-arms automatically.'
                : astra.wakeError || `Click the row to arm the wake word. Say “${wakeLabel}” plus your command, hands-free.`}
            </div>
            {editingWake ? (
              <div className="wake-edit">
                <input
                  className="wake-edit-input"
                  value={wakeDraft}
                  maxLength={40}
                  autoFocus
                  placeholder="wake word"
                  aria-label="Wake word"
                  onChange={(e) => { setWakeDraft(e.target.value); setWakeDraftError('') }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveWakeWord()
                    if (e.key === 'Escape') cancelWakeEditor()
                  }}
                />
                <div className="wake-edit-actions">
                  <button type="button" className="wake-edit-save" onClick={saveWakeWord}>Save</button>
                  <button type="button" className="wake-edit-cancel" onClick={cancelWakeEditor}>Cancel</button>
                </div>
                {wakeDraftError ? <p className="wake-edit-hint">{wakeDraftError}</p> : null}
              </div>
            ) : (
              <button type="button" className="module-row module-row--sub" onClick={openWakeEditor}>
                <span>Change wake word</span>
                <span className="module-state">✎</span>
              </button>
            )}
          </div>

          <div className="module-card">
            <div className="eyebrow">AGENT ACTIVITY</div>
            <div className="activity-head">
              <span className={`activity-link ${activity.connected ? 'is-on' : ''}`}>
                {activity.connected ? 'LIVE · AGENT BRIDGE' : 'BRIDGE OFFLINE'}
              </span>
            </div>
            <div className="activity-list">
              {activity.events.length === 0 && (
                <div className="activity-empty">No agent work yet — tool calls, shell runs and turns show up here.</div>
              )}
              {activity.events.map((event) => (
                <div key={event.id} className={`activity-item tone-${ACTIVITY_TONE[event.kind] || 'muted'}`}>
                  <span className="activity-kind">{event.kind}</span>
                  <span className="activity-text">{event.text}</span>
                  <span className="activity-time">
                    {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="module-card">
            <div className="eyebrow">QUICK ACCESS</div>
            <div className="quick-list">
              {QUICK_ACTIONS.map((action) => (
                <button key={action.label} className="quick-action" type="button" onClick={() => astra.send(action.prompt)}>
                  <span>{action.label}</span>
                  <span className="quick-arrow">↗</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-footer">
            <span className="footer-dot" />
            <span>Computer control is command-gated</span>
          </div>
        </aside>

        <section className="conversation">
          <div className="conversation-head">
            <div className="conversation-title">
              <div className="eyebrow">ASTRA</div>
              <h1 title={conversationTitle}>{conversationTitle}</h1>
            </div>
            <div className="session-chip"><span /> SECURE SESSION</div>
          </div>

          <ChatStream
            messages={astra.messages}
            streaming={astra.streaming}
            thinking={astra.thinking}
            onSuggest={(text) => astra.send(text)}
          />

          <CommandBar
            onSend={astra.send}
            streaming={astra.streaming}
            listening={astra.listening}
            voiceState={astra.voiceState}
            voiceError={astra.voiceError}
            onToggleListening={astra.toggleListening}
            voiceEnabled={astra.voiceEnabled}
            onToggleVoice={() => astra.setVoiceEnabled((value) => !value)}
            onClear={astra.clearChat}
          />
        </section>
      </main>
    </div>
  )
}
