import Image from 'next/image'

// Logo PNG is 862×345 (2.5:1). size controls rendered height; width scales proportionally.
export function SplitLogo({ size = 28 }: { size?: number }) {
  return (
    <Image
      src="/logo.png"
      alt="Split"
      height={size}
      width={Math.round(size * 2.5)}
      priority
      style={{ display: 'block' }}
    />
  )
}
