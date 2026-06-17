'use client'

import type { SplitBucket } from '@/lib/contracts'
import { ZERO_ADDRESS } from '@/lib/contracts'
import { UsdcAmount } from './usdc-amount'
import { Badge } from './badge'
import { bucketIconFor } from './bucket-icon'
import { shortAddress, formatUsdc } from '@/lib/format'
import { bpsToPCT } from '@/lib/bps'
import { SquarePen, ArrowDownToLine, CalendarClock, Target, Trash2 } from 'lucide-react'

const BUCKET_PALETTE = [
  { r: 29,  g: 158, b: 117 },
  { r: 96,  g: 165, b: 250 },
  { r: 168, g: 85,  b: 247 },
  { r: 251, g: 146, b: 60  },
  { r: 244, g: 114, b: 182 },
  { r: 34,  g: 211, b: 238 },
  { r: 251, g: 191, b: 36  },
  { r: 248, g: 113, b: 113 },
] as const

interface Props {
  bucket:       SplitBucket
  goal?:        bigint
  routedTotal?: bigint
  iconSlug?:    string
  colorIndex:   number
  onEdit:       () => void
  onWithdraw:   () => void
  onSchedule:   () => void
  onSetGoal:    () => void
  onDelete:     () => void
}

function Ring({ pct, color, Icon }: { pct: number; color: string; Icon: React.ComponentType<{ size?: number; color?: string }> }) {
  const r = 38
  const circumference = 2 * Math.PI * r
  const dash = Math.min(pct, 100) / 100 * circumference
  return (
    <div className="relative shrink-0" style={{ width: 96, height: 96 }}>
      <svg width={96} height={96} viewBox="0 0 96 96" style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
        <circle cx="48" cy="48" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="7" />
        <circle
          cx="48" cy="48" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`} style={{ transition: 'stroke-dasharray 0.5s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <Icon size={28} color={color} />
      </div>
    </div>
  )
}

const actionBtn = 'flex flex-col items-center gap-1 flex-1 rounded-lg py-1.5 transition-colors hover:bg-[rgba(255,255,255,0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'
const actionLabel = { fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 11 } as const

export function BucketCard({ bucket, goal, routedTotal, iconSlug, colorIndex, onEdit, onWithdraw, onSchedule, onSetGoal, onDelete }: Props) {
  const isHold      = bucket.destination === ZERO_ADDRESS
  const hasGoal     = goal !== undefined && goal > 0n
  const canWithdraw = bucket.balance > 0n
  const pct         = bpsToPCT(bucket.bps)
  const amount      = isHold ? bucket.balance : (routedTotal ?? 0n)
  const Icon        = bucketIconFor(iconSlug)

  const { r, g, b } = BUCKET_PALETTE[colorIndex % BUCKET_PALETTE.length]!
  const glow      = `${r},${g},${b}`
  const ringColor = `rgb(${r},${g},${b})`

  const progressRaw = hasGoal ? Math.min(100, (Number(amount) / Number(goal ?? 1n)) * 100) : 0
  const barWidth    = progressRaw > 0 ? Math.max(1, progressRaw) : 0
  const progressPct = progressRaw > 0 && progressRaw < 1
    ? progressRaw.toFixed(1)
    : String(Math.round(progressRaw))

  return (
    <article
      className="relative flex flex-col transition-all"
      style={{
        background: `
          radial-gradient(circle at 50% 40%, rgba(18,30,60,0.55) 0%, rgba(10,13,24,0.9) 55%, rgba(8,10,18,1) 100%),
          #0A0D18
        `,
        backdropFilter: 'blur(24px)',
        borderRadius: 16,
        padding: 20,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: `
          0 0 0 1px rgba(${glow},0.10),
          inset 0 1px 0 rgba(255,255,255,0.05),
          0 0 40px rgba(${glow},0.06)
        `,
      }}
    >

      {/* ── Nebula cloud atmosphere ── */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0, borderRadius: 16, pointerEvents: 'none',
          background: `
            radial-gradient(circle at 25% 45%, rgba(${glow},0.14) 0%, transparent 45%),
            radial-gradient(circle at 82% 62%, rgba(${glow},0.10) 0%, transparent 50%),
            radial-gradient(circle at 55% 95%, rgba(${glow},0.08) 0%, transparent 55%)
          `,
          filter: 'blur(52px)',
        }}
      />

      {/* ── Bottom organic wave forms ── */}
      <span aria-hidden="true" style={{
        position: 'absolute', bottom: '-8%', left: '5%',
        width: '65%', height: '38%', borderRadius: '50% 50% 0 0', pointerEvents: 'none',
        background: `radial-gradient(ellipse at center bottom, rgba(${glow},0.11), transparent 70%)`,
        filter: 'blur(22px)',
      }} />
      <span aria-hidden="true" style={{
        position: 'absolute', bottom: '-14%', left: '28%',
        width: '58%', height: '42%', borderRadius: '50% 45% 0 0', pointerEvents: 'none',
        background: `radial-gradient(ellipse at center bottom, rgba(${glow},0.08), transparent 65%)`,
        filter: 'blur(30px)',
      }} />
      <span aria-hidden="true" style={{
        position: 'absolute', bottom: '-5%', right: '4%',
        width: '42%', height: '32%', borderRadius: '50% 50% 0 0', pointerEvents: 'none',
        background: `radial-gradient(ellipse at center bottom, rgba(${glow},0.06), transparent 70%)`,
        filter: 'blur(20px)',
      }} />

      {/* ── Floating bubble particles ── */}
      <span aria-hidden="true" style={{ position: 'absolute', top: '16%',   right: '11%', width: 18, height: 18, borderRadius: 999, pointerEvents: 'none', background: `rgba(${glow},0.05)`, border: `1px solid rgba(${glow},0.28)`, boxShadow: `0 0 14px rgba(${glow},0.14)` }} />
      <span aria-hidden="true" style={{ position: 'absolute', top: '53%',   right: '7%',  width: 12, height: 12, borderRadius: 999, pointerEvents: 'none', background: `rgba(${glow},0.04)`, border: `1px solid rgba(${glow},0.22)`, boxShadow: `0 0 10px rgba(${glow},0.12)` }} />
      <span aria-hidden="true" style={{ position: 'absolute', top: '32%',   right: '23%', width: 8,  height: 8,  borderRadius: 999, pointerEvents: 'none', background: `rgba(${glow},0.04)`, border: `1px solid rgba(${glow},0.20)`, boxShadow: `0 0 8px rgba(${glow},0.10)`  }} />
      <span aria-hidden="true" style={{ position: 'absolute', bottom: '28%', right: '17%', width: 6,  height: 6,  borderRadius: 999, pointerEvents: 'none', background: `rgba(${glow},0.05)`, border: `1px solid rgba(${glow},0.25)`, boxShadow: `0 0 8px rgba(${glow},0.12)`  }} />
      <span aria-hidden="true" style={{ position: 'absolute', top: '68%',   right: '38%', width: 4,  height: 4,  borderRadius: 999, pointerEvents: 'none', background: `rgba(${glow},0.06)`, border: `1px solid rgba(${glow},0.30)`, boxShadow: `0 0 6px rgba(${glow},0.15)`  }} />
      <span aria-hidden="true" style={{ position: 'absolute', top: '80%',   right: '54%', width: 4,  height: 4,  borderRadius: 999, pointerEvents: 'none', background: `rgba(${glow},0.05)`, border: `1px solid rgba(${glow},0.22)`, boxShadow: `0 0 6px rgba(${glow},0.10)`  }} />
      <span aria-hidden="true" style={{ position: 'absolute', bottom: '20%', left: '14%',  width: 6,  height: 6,  borderRadius: 999, pointerEvents: 'none', background: `rgba(${glow},0.04)`, border: `1px solid rgba(${glow},0.18)`, boxShadow: `0 0 8px rgba(${glow},0.10)`  }} />
      <span aria-hidden="true" style={{ position: 'absolute', top: '44%',   left: '7%',   width: 8,  height: 8,  borderRadius: 999, pointerEvents: 'none', background: `rgba(${glow},0.04)`, border: `1px solid rgba(${glow},0.18)`, boxShadow: `0 0 10px rgba(${glow},0.10)` }} />

      {/* ── Content ── */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column' }}>

        <div className="flex items-center justify-between gap-3">
          <h3 className="min-w-0 truncate" style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 14, color: 'rgba(255,255,255,0.92)' }}>
            {bucket.name}
          </h3>
          <Badge variant={isHold ? 'holds' : 'auto-sends'} />
        </div>

        <p className={isHold ? '' : 'font-mono'} style={{ fontSize: 11, color: 'rgba(255,255,255,0.30)', marginTop: 2, fontFamily: isHold ? "'Inter', sans-serif" : undefined }}>
          {isHold ? 'Holds in contract' : shortAddress(bucket.destination)}
        </p>

        <div className="flex items-center gap-4" style={{ marginTop: 14 }}>
          <Ring pct={pct} color={ringColor} Icon={Icon} />
          <div className="min-w-0">
            <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.30)' }}>
              Allocation
            </p>
            <p className="font-mono tabular-nums" style={{ fontWeight: 700, fontSize: 22, color: 'rgba(255,255,255,0.92)', lineHeight: 1.1 }}>
              {pct % 1 === 0 ? pct : pct.toFixed(2)}%
            </p>
            <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.30)', marginTop: 8 }}>
              Amount
            </p>
            <UsdcAmount value={amount} className="text-[16px] font-semibold" />
            <p className="font-mono" style={{ fontSize: 11, color: 'rgba(255,255,255,0.30)' }}>≈ ${formatUsdc(amount)} USD</p>
          </div>
        </div>

        {hasGoal && (
          <div style={{ marginTop: 14 }}>
            <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 999, overflow: 'hidden' }}>
              <div
                style={{ height: '100%', background: ringColor, borderRadius: 999, width: `${barWidth}%`, transition: 'width 0.4s ease', opacity: 0.75 }}
                role="progressbar" aria-valuenow={Math.round(barWidth)} aria-valuemin={0} aria-valuemax={100} aria-label={`${progressPct}% of goal`}
              />
            </div>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.30)', marginTop: 6 }}>
              Goal: ${formatUsdc(goal)} · {progressPct}% there
            </p>
          </div>
        )}

        <div className="flex items-stretch" style={{ gap: 2, marginTop: 16, paddingTop: 14, borderTop: '0.5px solid rgba(255,255,255,0.08)' }}>
          <button type="button" onClick={onEdit} className={actionBtn} style={{ color: 'rgba(255,255,255,0.45)' }}>
            <SquarePen size={15} /><span style={actionLabel}>Edit</span>
          </button>
          <button
            type="button" onClick={onWithdraw} disabled={!canWithdraw}
            className={canWithdraw ? actionBtn : 'flex flex-col items-center gap-1 flex-1 rounded-lg py-1.5'}
            style={{ color: canWithdraw ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.18)', cursor: canWithdraw ? 'pointer' : 'not-allowed' }}
          >
            <ArrowDownToLine size={15} /><span style={actionLabel}>Withdraw</span>
          </button>
          <button type="button" onClick={onSchedule} className={actionBtn} style={{ color: 'rgba(255,255,255,0.45)' }}>
            <CalendarClock size={15} /><span style={actionLabel}>Schedule</span>
          </button>
          <button type="button" onClick={onSetGoal} className={actionBtn} style={{ color: hasGoal ? ringColor : 'rgba(255,255,255,0.45)' }}>
            <Target size={15} /><span style={actionLabel}>Goal</span>
          </button>
        </div>

        <button
          type="button" onClick={onDelete}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg transition-colors hover:bg-[rgba(239,68,68,0.08)]"
          style={{ ...actionLabel, color: 'var(--danger)', marginTop: 6, padding: '6px 0' }}
        >
          <Trash2 size={12} />
          Delete
        </button>

      </div>
    </article>
  )
}
