import Image from 'next/image'

// PNG is 862×345 (2.5:1). The S icon occupies the leftmost square portion (~40% width).
// We crop to show only the icon via overflow:hidden, then render "Split" as an HTML
// element so its color follows var(--text) and stays readable in both light and dark mode.
export function SplitLogo({ size = 28 }: { size?: number }) {
  const gap = Math.round(size * 0.3)
  const fontSize = Math.round(size * 0.64)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap }}>
      <div style={{ width: size, height: size, overflow: 'hidden', flexShrink: 0 }}>
        <Image
          src="/logo.png"
          alt=""
          height={size}
          width={Math.round(size * 2.5)}
          priority
          style={{ display: 'block' }}
        />
      </div>
      <span
        aria-hidden="true"
        style={{
          fontFamily: 'var(--font-sans)',
          fontWeight: 700,
          fontSize,
          color: 'var(--text)',
          letterSpacing: '-0.01em',
          lineHeight: 1,
        }}
      >
        Split
      </span>
    </div>
  )
}
