import Image from 'next/image'

// Dark logo: 862×345 (2.5:1) — white text, shown in dark mode only
// Light logo: 1774×887 (2.0:1) — dark text, shown in light mode only
export function SplitLogo({ size = 28 }: { size?: number }) {
  return (
    <>
      <Image
        src="/logo.png"
        alt="Split"
        height={size}
        width={Math.round(size * 2.5)}
        priority
        className="hidden dark:block"
      />
      <Image
        src="/logo-light.png"
        alt="Split"
        height={size}
        width={Math.round(size * 2)}
        priority
        className="block dark:hidden"
      />
    </>
  )
}
