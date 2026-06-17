'use client'

import { PieChart } from 'lucide-react'
import type { SplitBucket } from '@/lib/contracts'
import { ZERO_ADDRESS } from '@/lib/contracts'
import { bpsToPCT } from '@/lib/bps'
import { formatUsdc } from '@/lib/format'
import { UsdcAmount } from './usdc-amount'

// Distinct colours per bucket. First two land on green/blue to match the mockup's
// auto-send/hold pairing; extras cycle through a small palette.
const PALETTE = ['var(--accent)', 'var(--info)', 'var(--warning)', '#A855F7', '#EC4899', '#14B8A6', '#F97316', '#3B82F6']

interface Props {
  buckets:       SplitBucket[]
  routedTotals?: Record<string, string>
}

export function AllocationOverview({ buckets, routedTotals }: Props) {
  const rows = buckets.map((b, i) => {
    const isHold = b.destination === ZERO_ADDRESS
    const raw    = routedTotals?.[String(b.id)]
    const amount = isHold ? b.balance : (raw ? BigInt(raw) : 0n)
    return { id: String(b.id), name: b.name, pct: bpsToPCT(b.bps), amount, color: PALETTE[i % PALETTE.length]! }
  })
  const total = rows.reduce((sum, r) => sum + r.amount, 0n)

  return (
    <section style={{ background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 14, padding: 20 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 16 }}>
        <PieChart size={16} color="var(--accent)" />
        <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>Allocation overview</h2>
      </div>

      <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
        Total allocated
      </p>
      <div className="flex items-baseline gap-2" style={{ marginTop: 2 }}>
        <UsdcAmount value={total} className="text-[22px] font-bold" />
        <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>≈ ${formatUsdc(total)} USD</span>
      </div>

      {/* Stacked allocation bar */}
      <div className="flex overflow-hidden" style={{ height: 10, borderRadius: 999, marginTop: 16, background: 'var(--bg-3)' }}>
        {rows.map((r) => (
          <div key={r.id} style={{ width: `${r.pct}%`, background: r.color }} title={`${r.name} ${r.pct}%`} />
        ))}
      </div>

      {/* Legend */}
      <ul className="flex flex-wrap" style={{ gap: '8px 20px', marginTop: 16 }}>
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: r.color, flexShrink: 0 }} />
            <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: 'var(--text)' }}>{r.name}</span>
            <span className="font-mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
              {formatUsdc(r.amount)} USDC ({r.pct % 1 === 0 ? r.pct : r.pct.toFixed(2)}%)
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
