// Stylized USDC coin on a green perspective-grid glow. Pure SVG approximation of the
// mockup's 3D render — decorative only.
export function CoinGraphic({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="coinGlow" cx="50%" cy="55%" r="60%">
          <stop offset="0%" stopColor="var(--accent, #1D9E75)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent, #1D9E75)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="coinFace" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3A3A42" />
          <stop offset="100%" stopColor="#111114" />
        </linearGradient>
        <linearGradient id="coinEdge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#26262C" />
          <stop offset="100%" stopColor="#0A0A0C" />
        </linearGradient>
      </defs>

      {/* Glow */}
      <circle cx="100" cy="110" r="95" fill="url(#coinGlow)" />

      {/* Perspective grid */}
      <g stroke="var(--accent, #1D9E75)" strokeOpacity="0.25" strokeWidth="0.8">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <line key={`h${i}`} x1="20" y1={150 + i * 9} x2="180" y2={150 + i * 9} />
        ))}
        {[-3, -2, -1, 0, 1, 2, 3].map((i) => (
          <line key={`v${i}`} x1={100 + i * 26} y1="150" x2={100 + i * 60} y2="196" />
        ))}
      </g>

      {/* Coin (slightly tilted) */}
      <g transform="translate(100 96) rotate(-12)">
        <ellipse cx="0" cy="9" rx="46" ry="44" fill="url(#coinEdge)" />
        <ellipse cx="0" cy="2" rx="46" ry="44" fill="url(#coinFace)" stroke="#4A4A52" strokeWidth="1" />
        <ellipse cx="0" cy="2" rx="37" ry="35" fill="none" stroke="var(--accent, #1D9E75)" strokeOpacity="0.55" strokeWidth="2" />
        <text x="0" y="14" textAnchor="middle" fontSize="40" fontWeight="700" fill="#F5F5F7" fontFamily="Inter, sans-serif">$</text>
      </g>
    </svg>
  )
}
