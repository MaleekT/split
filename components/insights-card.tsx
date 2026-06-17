'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isAddress, formatUnits } from 'viem'
import { BarChart3, ArrowUp, ArrowDown } from 'lucide-react'

// Minimal shape of the items /api/activity returns (see app/api/activity/[address]/route.ts).
interface ActivityItem {
  kind: 'deposit' | 'auto_send' | 'scheduled_send' | 'withdraw'
  amountRaw: string
  timestamp: number
}

const DAY = 86_400
const usd = (raw: bigint) => parseFloat(formatUnits(raw, 6))

function pctChange(curr: number, prev: number): number | null {
  if (prev === 0) return curr > 0 ? 100 : null
  return ((curr - prev) / prev) * 100
}

const LABEL_STYLE: React.CSSProperties = {
  fontFamily: "'Inter', sans-serif",
  fontSize: 11,
  lineHeight: 1.4,
  color: 'var(--text-2)',
}

const VALUE_STYLE: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 20,
  color: 'var(--text)',
}

function Sparkline({ points }: { points: number[] }) {
  const w = 120, h = 36
  if (points.length < 2) return <svg width={w} height={h} aria-hidden="true" />
  const max = Math.max(...points, 1)
  const step = w / (points.length - 1)
  const coords = points.map((p, i) => [i * step, h - (p / max) * (h - 4) - 2] as const)
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const area = `${line} L${w} ${h} L0 ${h} Z`
  return (
    <svg width={w} height={h} aria-hidden="true">
      <path d={area} fill="var(--accent-bg)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StatChange({ change }: { change: number | null }) {
  if (change === null) return <div role="presentation" />
  const up = change >= 0
  return (
    <span className="inline-flex items-center gap-1" style={{ fontSize: 11, fontWeight: 600, color: up ? 'var(--accent)' : 'var(--danger)' }}>
      {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
      <span>{Math.abs(change).toFixed(1)}%</span>
    </span>
  )
}

interface Props {
  address: string
}

export function InsightsCard({ address }: Props) {
  const [days, setDays] = useState(7)

  const { data } = useQuery({
    queryKey: ['activity', address],
    queryFn: async () => {
      if (!isAddress(address)) throw new Error('Invalid address')
      const res = await fetch(`/api/activity/${encodeURIComponent(address)}`)
      if (!res.ok) throw new Error('Failed to load activity')
      const json = (await res.json()) as { data: ActivityItem[] }
      return json.data
    },
    staleTime: 10_000,
  })

  const stats = useMemo(() => {
    const items = data ?? []
    const now = Math.floor(Date.now() / 1000)
    const currStart = now - days * DAY
    const prevStart = now - 2 * days * DAY

    const sum = (list: ActivityItem[], kind: ActivityItem['kind']) =>
      list.filter((i) => i.kind === kind).reduce((a, i) => a + (() => { try { return BigInt(i.amountRaw) } catch { return 0n } })(), 0n)

    const curr = items.filter((i) => i.timestamp >= currStart)
    const prev = items.filter((i) => i.timestamp >= prevStart && i.timestamp < currStart)

    const depCurr = sum(curr, 'deposit'), depPrev = sum(prev, 'deposit')
    const autoCurr = sum(curr, 'auto_send'), autoPrev = sum(prev, 'auto_send')

    // Hourly buckets for 7-day view (168 pts) so same-day transactions show variation.
    // Daily buckets for 30-day view (30 pts).
    const HOUR = 3_600
    const bucketUnit  = days === 7 ? HOUR : DAY
    const bucketCount = days === 7 ? days * 24 : days
    // Accumulate as bigint (exact integers); convert with usd() once per bucket — same
    // normalization path as the deposit/autoSent stats above.
    const rawBuckets = new Array(bucketCount).fill(0n) as bigint[]
    for (const i of curr) {
      if (i.kind !== 'deposit') continue
      const idx = Math.min(bucketCount - 1, Math.floor((i.timestamp - currStart) / bucketUnit))
      if (idx >= 0) {
        let raw = 0n
        try { raw = BigInt(i.amountRaw) } catch { raw = 0n }
        rawBuckets[idx] = (rawBuckets[idx] ?? 0n) + raw
      }
    }
    const buckets = rawBuckets.map(r => usd(r))

    // Trim leading and trailing zero-buckets so the chart zooms to the active window.
    // One 0 is kept on each side for slope context. All-zero (no activity) stays as-is.
    const firstNonZero = buckets.findIndex(v => v > 0)
    let spark: number[]
    if (firstNonZero < 0) {
      spark = buckets
    } else {
      let lastNonZero = firstNonZero
      for (let j = buckets.length - 1; j > firstNonZero; j--) {
        if ((buckets[j] ?? 0) > 0) { lastNonZero = j; break }
      }
      spark = [0, ...buckets.slice(firstNonZero, lastNonZero + 1), 0]
    }

    return {
      deposits:    usd(depCurr),
      autoSent:    usd(autoCurr),
      txCount:     curr.length,
      depChange:   pctChange(usd(depCurr), usd(depPrev)),
      autoChange:  pctChange(usd(autoCurr), usd(autoPrev)),
      txChange:    pctChange(curr.length, prev.length),
      spark,
    }
  }, [data, days])

  return (
    <section style={{ background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 14, padding: 20 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 18 }}>
        <div className="flex items-center gap-2">
          <BarChart3 size={16} color="var(--accent)" />
          <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>Insights</h2>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Insights period"
          className="font-sans"
          style={{ fontSize: 12, color: 'var(--text-2)', background: 'var(--bg-3)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '4px 8px' }}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      <div className="flex items-end justify-between gap-4">
        {/* 3-col grid: labels/values/changes share grid rows so Y-positions stay aligned regardless of label wrap */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', columnGap: '1.5rem', rowGap: '2px' }}>
          <p style={LABEL_STYLE}>Total deposits</p>
          <p style={LABEL_STYLE}>Auto-sent</p>
          <p style={LABEL_STYLE}>Transactions</p>
          <p className="font-mono tabular-nums" style={VALUE_STYLE}>{`$${stats.deposits.toFixed(2)}`}</p>
          <p className="font-mono tabular-nums" style={VALUE_STYLE}>{`$${stats.autoSent.toFixed(2)}`}</p>
          <p className="font-mono tabular-nums" style={VALUE_STYLE}>{String(stats.txCount)}</p>
          <StatChange change={stats.depChange} />
          <StatChange change={stats.autoChange} />
          <StatChange change={stats.txChange} />
        </div>
        <Sparkline points={stats.spark} />
      </div>
    </section>
  )
}
