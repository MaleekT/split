'use client'

import type { SplitBucket } from '@/lib/contracts'
import { ZERO_ADDRESS } from '@/lib/contracts'
import { UsdcAmount } from './usdc-amount'
import { Badge } from './badge'
import { bucketIconFor } from './bucket-icon'
import { shortAddress, formatUsdc } from '@/lib/format'
import { bpsToPCT } from '@/lib/bps'
import { SquarePen, ArrowDownToLine, CalendarClock, Target, Trash2 } from 'lucide-react'

interface Props {
  bucket:       SplitBucket
  goal?:        bigint
  routedTotal?: bigint
  iconSlug?:    string
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
        <circle cx="48" cy="48" r={r} fill="none" stroke="var(--bg-3)" strokeWidth="7" />
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

const actionItem = 'flex flex-col items-center gap-1 flex-1 rounded-lg py-1.5 transition-colors hover:bg-[var(--bg-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'
const actionLabel = { fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 11 } as const

export function BucketCard({ bucket, goal, routedTotal, iconSlug, onEdit, onWithdraw, onSchedule, onSetGoal, onDelete }: Props) {
  const isHold      = bucket.destination === ZERO_ADDRESS
  const hasGoal     = goal !== undefined && goal > 0n
  const canWithdraw = bucket.balance > 0n
  const pct         = bpsToPCT(bucket.bps)
  const ringColor   = isHold ? 'var(--info)' : 'var(--accent)'
  const amount      = isHold ? bucket.balance : (routedTotal ?? 0n)
  const Icon        = bucketIconFor(iconSlug)

  // Float percentage — avoids BigInt truncation that makes sub-1% progress appear as 0
  const progressRaw = hasGoal ? Math.min(100, (Number(amount) / Number(goal ?? 1n)) * 100) : 0
  // Bar: clamp to ≥1% wide whenever there is any progress so the fill is always visible
  const barWidth    = progressRaw > 0 ? Math.max(1, progressRaw) : 0
  // Label: show one decimal for sub-1% (e.g. "0.7%"), whole number otherwise
  const progressPct = progressRaw > 0 && progressRaw < 1
    ? progressRaw.toFixed(1)
    : String(Math.round(progressRaw))

  const glowRgb = isHold ? '96,165,250' : '29,158,117'

  return (
    <article
      className="relative flex flex-col transition-colors"
      style={{
        background: `radial-gradient(ellipse at 35% 62%, rgba(${glowRgb},0.11) 0%, transparent 62%), var(--bg-2)`,
        border: `0.5px solid rgba(${glowRgb},0.28)`,
        borderRadius: 14,
        padding: 18,
      }}
    >
      {/* Decorative ghost rings */}
      <span aria-hidden="true" style={{ position: 'absolute', right: 48, top: '46%', width: 11, height: 11, borderRadius: 999, border: `1px solid rgba(${glowRgb},0.18)`, pointerEvents: 'none' }} />
      <span aria-hidden="true" style={{ position: 'absolute', right: 22, top: '60%', width: 7, height: 7, borderRadius: 999, border: `1px solid rgba(${glowRgb},0.10)`, pointerEvents: 'none' }} />

      {/* Header: name + badge */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate" style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
          {bucket.name}
        </h3>
        <Badge variant={isHold ? 'holds' : 'auto-sends'} />
      </div>
      <p className={isHold ? '' : 'font-mono'} style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, fontFamily: isHold ? "'Inter', sans-serif" : undefined }}>
        {isHold ? 'Holds in contract' : shortAddress(bucket.destination)}
      </p>

      {/* Ring + stats */}
      <div className="flex items-center gap-4" style={{ marginTop: 14 }}>
        <Ring pct={pct} color={ringColor} Icon={Icon} />
        <div className="min-w-0">
          <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
            Allocation
          </p>
          <p className="font-mono tabular-nums" style={{ fontWeight: 700, fontSize: 22, color: 'var(--text)', lineHeight: 1.1 }}>
            {pct % 1 === 0 ? pct : pct.toFixed(2)}%
          </p>
          <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)', marginTop: 8 }}>
            Amount
          </p>
          <UsdcAmount value={amount} className="text-[16px] font-semibold" />
          <p className="font-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>≈ ${formatUsdc(amount)} USD</p>
        </div>
      </div>

      {/* Goal bar */}
      {hasGoal && (
        <div style={{ marginTop: 14 }}>
          <div style={{ height: 6, background: 'var(--bg-3)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: 'var(--warning)', borderRadius: 999, width: `${barWidth}%`, transition: 'width 0.4s ease' }} role="progressbar" aria-valuenow={Math.round(barWidth)} aria-valuemin={0} aria-valuemax={100} aria-label={`${progressPct}% of goal`} />
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            Goal: ${formatUsdc(goal)} · {progressPct}% there
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-stretch" style={{ gap: 2, marginTop: 16, paddingTop: 14, borderTop: '0.5px solid var(--border)' }}>
        <button type="button" onClick={onEdit} className={actionItem} style={{ color: 'var(--text-2)' }}>
          <SquarePen size={15} /><span style={actionLabel}>Edit</span>
        </button>
        <button type="button" onClick={onWithdraw} disabled={!canWithdraw} className={canWithdraw ? actionItem : 'flex flex-col items-center gap-1 flex-1 rounded-lg py-1.5'} style={{ color: canWithdraw ? 'var(--text-2)' : 'var(--text-3)', cursor: canWithdraw ? 'pointer' : 'not-allowed' }}>
          <ArrowDownToLine size={15} /><span style={actionLabel}>Withdraw</span>
        </button>
        <button type="button" onClick={onSchedule} className={actionItem} style={{ color: 'var(--text-2)' }}>
          <CalendarClock size={15} /><span style={actionLabel}>Schedule</span>
        </button>
        <button type="button" onClick={onSetGoal} className={actionItem} style={{ color: hasGoal ? 'var(--accent)' : 'var(--text-2)' }}>
          <Target size={15} /><span style={actionLabel}>Goal</span>
        </button>
      </div>
      <button
        type="button"
        onClick={onDelete}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg transition-colors hover:bg-[var(--danger-bg)]"
        style={{ ...actionLabel, color: 'var(--danger)', marginTop: 6, padding: '6px 0' }}
      >
        <Trash2 size={12} />
        Delete
      </button>
    </article>
  )
}
