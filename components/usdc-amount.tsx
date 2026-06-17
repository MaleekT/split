import { formatUnits } from 'viem'

interface Props {
  /** Raw 6-decimal USDC amount as a bigint. Never pass a pre-divided float. */
  value: bigint
  /** Extra Tailwind classes applied to the outer span. */
  className?: string
}

/**
 * Renders a USDC amount with exactly 2 decimal places and a " USDC" suffix.
 * Always uses formatUnits(value, 6) — never divides by 1e6 inline.
 */
export function UsdcAmount({ value, className = '' }: Props) {
  const display = parseFloat(formatUnits(value, 6)).toFixed(2)

  return (
    <span
      className={`font-mono tabular-nums ${className}`}
      aria-label={`${display} USDC`}
    >
      {display}
      <span className="text-[var(--split-text-secondary,#6f6e69)] ml-1 text-[0.8em] font-normal">
        USDC
      </span>
    </span>
  )
}
