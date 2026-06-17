import Image from 'next/image'

// Both logos: 1774×887 (2.0:1)
// Dark mode: /logo.png (Split Dark Mode.png) — white text
// Light mode: /logo-light.png (Split Light MOde.png) — dark text
export function SplitLogo({ size = 28 }: { size?: number }) {
  return (
    <>
      <Image
        src="/logo.png"
        alt="Split"
        height={size}
        width={Math.round(size * 2)}
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
