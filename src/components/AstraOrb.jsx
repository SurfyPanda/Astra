/**
 * The Astra presence: a layered reactor-core orb that reacts to state —
 * idle (slow breathe), listening (ripples), thinking (fast spin), speaking (waveform).
 * Pure SVG + CSS animation, no canvas needed.
 */
export default function AstraOrb({ listening, thinking, speaking }) {
  const state = thinking ? 'thinking' : speaking ? 'speaking' : listening ? 'listening' : 'idle'

  return (
    <div className={`orb orb--${state}`} aria-hidden="true">
      <div className="orb-ripples">
        <span className="ripple r1" />
        <span className="ripple r2" />
        <span className="ripple r3" />
      </div>

      <svg className="orb-rings" viewBox="0 0 200 200">
        <circle className="ring ring-1" cx="100" cy="100" r="88" />
        <circle className="ring ring-2" cx="100" cy="100" r="72" />
        <circle className="ring ring-3" cx="100" cy="100" r="56" />
        {/* tick marks like a HUD compass */}
        {Array.from({ length: 24 }).map((_, i) => {
          const a = (i * 15 * Math.PI) / 180
          const x1 = 100 + Math.cos(a) * 92
          const y1 = 100 + Math.sin(a) * 92
          const x2 = 100 + Math.cos(a) * 97
          const y2 = 100 + Math.sin(a) * 97
          return <line key={i} className="tick" x1={x1} y1={y1} x2={x2} y2={y2} />
        })}
      </svg>

      {speaking && (
        <div className="orb-waveform">
          {Array.from({ length: 9 }).map((_, i) => (
            <span key={i} className="bar" style={{ animationDelay: `${i * 0.09}s` }} />
          ))}
        </div>
      )}

      <div className="orb-core">
        <div className="core-inner" />
        <div className="core-flare" />
      </div>

      <div className="orb-particles">
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="particle" style={{ '--angle': `${i * 60}deg`, animationDelay: `${i * 0.7}s` }} />
        ))}
      </div>
    </div>
  )
}
