import { useEffect, useRef, useState } from 'react'

const COMMANDS = [
  { cmd: '/help', desc: 'Available commands' },
  { cmd: '/status', desc: 'System status' },
  { cmd: '/time', desc: 'Current time' },
  { cmd: '/remember', desc: 'Save a memory note' },
  { cmd: '/recall', desc: 'Recall memory notes' },
  { cmd: '/diagnostics', desc: 'Run diagnostics' },
  { cmd: '/erase', desc: 'Erase memory notes' },
  { cmd: '/clear', desc: 'Clear this session' },
]

export default function CommandBar({
  onSend,
  streaming,
  listening,
  voiceState,
  voiceError,
  onToggleListening,
  voiceEnabled,
  onToggleVoice,
  onClear,
}) {
  const [value, setValue] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const inputRef = useRef(null)

  const showPalette = value.startsWith('/')
  const query = value.slice(1).split(' ')[0].toLowerCase()
  const matches = COMMANDS.filter((command) => command.cmd.slice(1).startsWith(query))

  useEffect(() => {
    if (listening) inputRef.current?.blur()
  }, [listening])

  const submit = () => {
    const text = value.trim()
    if (!text || streaming) return
    onSend(text)
    setValue('')
    setPaletteIndex(0)
  }

  const handleKeyDown = (event) => {
    if (showPalette && matches.length > 0) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setPaletteIndex((index) => (index + 1) % matches.length); return }
      if (event.key === 'ArrowUp') { event.preventDefault(); setPaletteIndex((index) => (index - 1 + matches.length) % matches.length); return }
      if (event.key === 'Tab') { event.preventDefault(); setValue(`${matches[paletteIndex].cmd} `); return }
      if (event.key === 'Enter' && !value.includes(' ')) { event.preventDefault(); setValue(`${matches[paletteIndex].cmd} `); return }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const micLabel = listening ? 'Stop microphone' : voiceState === 'starting' ? 'Starting microphone' : 'Start microphone'

  return (
    <div className="composer-wrap">
      {voiceError && <div className="voice-error"><span>!</span>{voiceError}</div>}

      {showPalette && matches.length > 0 && (
        <ul className="command-palette" role="listbox">
          {matches.map((command, index) => (
            <li
              key={command.cmd}
              role="option"
              aria-selected={index === paletteIndex}
              className={index === paletteIndex ? 'selected' : ''}
              onMouseEnter={() => setPaletteIndex(index)}
              onClick={() => setValue(`${command.cmd} `)}
            >
              <span className="palette-cmd">{command.cmd}</span>
              <span className="palette-desc">{command.desc}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="composer">
        <button
          type="button"
          className={`mic-button ${listening ? 'is-listening' : ''} ${voiceState === 'starting' ? 'is-starting' : ''}`}
          onClick={onToggleListening}
          title={micLabel}
          aria-label={micLabel}
          disabled={streaming}
        >
          {listening ? (
            <span className="mic-glyph mic-stop" aria-hidden="true" />
          ) : (
            <svg className="mic-icon" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="8" y="3" width="8" height="12" rx="4" />
              <path d="M5 11.5a7 7 0 0 0 14 0M12 18.5v3M8.5 21.5h7" />
            </svg>
          )}
        </button>

        <div className="input-zone">
          <textarea
            ref={inputRef}
            className="command-input"
            rows={1}
            placeholder={listening ? 'Listening for your request…' : 'Message ASTRA'}
            value={value}
            onChange={(event) => { setValue(event.target.value); setPaletteIndex(0) }}
            onKeyDown={handleKeyDown}
            aria-label="Message ASTRA"
          />
          <div className="input-meta">
            <span>{listening ? 'VOICE INPUT ACTIVE' : 'ENTER TO SEND · SHIFT+ENTER FOR NEW LINE'}</span>
            <span className="input-mode">TEXT + COMMANDS</span>
          </div>
        </div>

        <button
          type="button"
          className={`utility-button ${voiceEnabled ? 'is-active' : ''}`}
          onClick={onToggleVoice}
          title={voiceEnabled ? 'Mute ASTRA voice' : 'Enable ASTRA voice'}
          aria-label={voiceEnabled ? 'Mute ASTRA voice' : 'Enable ASTRA voice'}
        >
          {voiceEnabled ? (
            <svg className="utility-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-6 8a6 6 0 0 0 12 0M12 17v4M8.5 21h7" /></svg>
          ) : (
            <svg className="utility-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Zm7 5-4 4m0-4 4 4" /></svg>
          )}
        </button>

        <button type="button" className="utility-button" onClick={onClear} title="Clear session" aria-label="Clear session">
          ⌫
        </button>

        <button
          type="button"
          className="send-button"
          onClick={submit}
          disabled={streaming || !value.trim()}
          aria-label="Send message"
        >
          {streaming ? '…' : '→'}
        </button>
      </div>
    </div>
  )
}
