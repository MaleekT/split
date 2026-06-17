'use client'

import { sumBPS, type BucketLike } from '@/lib/bps'

const BPS_TOTAL = 10_000

interface BpsIndicatorProps {
  buckets?: BucketLike[]
}

export function BpsIndicator({ buckets = [] }: BpsIndicatorProps) {
  const total   = sumBPS(buckets)
  const pct     = Math.min((total / BPS_TOTAL) * 100, 100)
  const exact   = total === BPS_TOTAL
  const over    = total > BPS_TOTAL

  const barCls  = exact ? 'bg-[var(--split-accent)]'
                : over  ? 'bg-[var(--split-text-danger)]'
                        : 'bg-amber-400'
  const textCls = exact ? 'text-[var(--split-accent)]'
                : over  ? 'text-[var(--split-text-danger)]'
                        : 'text-amber-600'

  const displayPct = (total / 100).toFixed(2)

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-[var(--split-text-secondary)]">Total allocation</span>
        <span className={`font-mono font-semibold tabular-nums ${textCls}`}>
          {displayPct}/100%
        </span>
      </div>

      <div className="h-1.5 rounded-full bg-[rgba(0,0,0,0.06)] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barCls}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {!exact && (
        <p className={`text-xs ${textCls}`}>
          {over
            ? `Over by ${((total - BPS_TOTAL) / 100).toFixed(2)}% — reduce an allocation`
            : `${((BPS_TOTAL - total) / 100).toFixed(2)}% unallocated`}
        </p>
      )}
    </div>
  )
}
