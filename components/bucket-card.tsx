'use client'

import { useRef } from 'react'
import type { SplitBucket } from '@/lib/contracts'
import { ZERO_ADDRESS } from '@/lib/contracts'
import { UsdcAmount } from './usdc-amount'
import { Badge } from './badge'
import { bucketIconFor } from './bucket-icon'
import { shortAddress, formatUsdc } from '@/lib/format'
import { bpsToPCT } from '@/lib/bps'
import {
  ArrowDownToLine,
  CalendarClock,
  MoreHorizontal,
  Send,
  SquarePen,
  Target,
  Trash2,
} from 'lucide-react'

const BUCKET_PALETTE = [
  { r: 29,  g: 158, b: 117 },
  { r: 59,  g: 130, b: 246 },
  { r: 147, g: 51,  b: 234 },
  { r: 234, g: 88,  b: 12  },
  { r: 219, g: 39,  b: 119 },
  { r: 8,   g: 145, b: 178 },
  { r: 202, g: 138, b: 4   },
  { r: 220, g: 38,  b: 38  },
] as const

interface Props {
  bucket: SplitBucket
  goal?: bigint
  routedTotal?: bigint
  iconSlug?: string
  colorIndex: number
  onEdit: () => void
  onWithdraw: () => void
  isGenerated?: boolean
  isPrimary?: boolean
  onSendFromWallet?: () => void
  /**
   * Classification of this bucket's destination, when it is a lock. A locked
   * bucket is a THIRD kind of bucket, not a flag: its money lives in its own
   * contract, so its balance, its status line and its withdraw action all differ.
   */
  lock?: {
    classification: 'ELIGIBLE' | 'FOREIGN' | 'UNSUPPORTED' | 'ORDINARY' | 'UNAVAILABLE' | 'CONFLICT'
    balance?: bigint
    unlockedNow?: boolean
    unlockAt?: bigint
    target?: bigint
    targetMet?: boolean
  }
  onWithdrawLock?: () => void
  onSchedule: () => void
  onSetGoal: () => void
  onDelete: () => void
}

/**
 * The one-line status under a locked bucket's amount. Prefers the target when one
 * is set and still short, since "312 of 500" is more actionable than a date
 * months away; otherwise counts down to the unlock date.
 */
function lockStatusLine(lock?: {
  unlockAt?: bigint; target?: bigint; targetMet?: boolean; balance?: bigint
}): string {
  if (!lock) return 'Locked'
  const { unlockAt, target, targetMet, balance } = lock
  if (target !== undefined && target > 0n && !targetMet && balance !== undefined && balance < target) {
    return `${formatUsdc(balance)} of ${formatUsdc(target)}`
  }
  if (unlockAt !== undefined && unlockAt > 0n) {
    const days = Number(unlockAt - BigInt(Math.floor(Date.now() / 1000))) / 86_400
    if (days <= 0) return 'Ready to withdraw'
    if (days < 1)  return 'Unlocks today'
    if (days < 2)  return 'Unlocks tomorrow'
    return `Unlocks in ${Math.ceil(days)} days`
  }
  return 'Locked'
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="bucket-card-action"
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

export function BucketCard({
  bucket,
  goal,
  routedTotal,
  iconSlug,
  colorIndex,
  onEdit,
  onWithdraw,
  onSchedule,
  onSetGoal,
  onDelete,
  isGenerated = false,
  isPrimary = false,
  lock,
  onWithdrawLock,
  onSendFromWallet,
}: Props) {
  const menuRef = useRef<HTMLDetailsElement>(null)
  const isHold = bucket.destination === ZERO_ADDRESS
  // A lock this user actually owns. FOREIGN, UNSUPPORTED, UNAVAILABLE and
  // CONFLICT deliberately do NOT qualify: each renders differently and none may
  // present the balance as this user's spendable money.
  const isLocked = lock?.classification === 'ELIGIBLE'
  const lockConflict = lock?.classification === 'CONFLICT'
  const lockForeign = lock?.classification === 'FOREIGN'
  const lockUnavailable = lock?.classification === 'UNAVAILABLE'
  const hasGoal = goal !== undefined && goal > 0n
  const canWithdraw = bucket.balance > 0n
  const pct = bpsToPCT(bucket.bps)
  // A locked bucket's money lives in its own contract, so its balance is read
  // from there. Falling back to cumulative routed totals would over-report after
  // any withdrawal.
  const amount = isHold
    ? bucket.balance
    : (isLocked || lockConflict) && lock?.balance !== undefined
      ? lock.balance
      : (routedTotal ?? 0n)
  const Icon = bucketIconFor(iconSlug)
  const accent = BUCKET_PALETTE[colorIndex % BUCKET_PALETTE.length]!
  const accentColor = `rgb(${accent.r}, ${accent.g}, ${accent.b})`
  const accentSoft = `rgba(${accent.r}, ${accent.g}, ${accent.b}, 0.12)`

  const progressRaw = hasGoal
    ? Math.min(100, (Number(amount) / Number(goal ?? 1n)) * 100)
    : 0
  const progressPct = progressRaw > 0 && progressRaw < 1
    ? progressRaw.toFixed(1)
    : String(Math.round(progressRaw))

  function runMenuAction(action: () => void) {
    if (menuRef.current) menuRef.current.open = false
    action()
  }

  return (
    <article
      className="bucket-card"
      style={{
        '--bucket-accent': accentColor,
        '--bucket-accent-soft': accentSoft,
      } as React.CSSProperties}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="bucket-card-icon" aria-hidden="true">
            <Icon size={20} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>
              {bucket.name}
            </h3>
            <p
              className={isHold ? '' : 'font-mono'}
              style={{ color: 'var(--text-2)', fontSize: 11, marginTop: 1, fontFamily: isHold ? "'Inter', sans-serif" : undefined }}
            >
              {isHold ? 'Holds in contract'
              : isLocked ? (lock?.unlockedNow ? 'Unlocked' : 'Locked')
              : lockConflict ? 'Shared lock'
              : lockForeign ? 'Not your lock'
              : lockUnavailable ? 'Could not verify'
              : shortAddress(bucket.destination)}
            </p>
          </div>
        </div>
        <Badge variant={isHold ? 'holds' : 'auto-sends'} />
      </div>

      <div className="bucket-card-balance">
        <p className="bucket-card-label">Balance</p>
        <UsdcAmount value={amount} className="text-[16px] font-semibold" />
        <p className="font-mono" style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 2 }}>
          ≈ ${formatUsdc(amount)} USD
        </p>
      </div>

      <div className="bucket-card-allocation">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="bucket-card-label">Allocation</p>
            <p className="font-mono tabular-nums" style={{ color: 'var(--text)', fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>
              {pct % 1 === 0 ? pct : pct.toFixed(2)}%
            </p>
          </div>
          <p className="truncate text-right" style={{ color: 'var(--text-2)', fontSize: 11 }}>
            {isLocked ? (lock?.unlockedNow ? 'Ready to withdraw' : lockStatusLine(lock))
              : lockConflict ? 'Shared with another bucket'
              : lockForeign ? 'Owned by another account'
              : lockUnavailable ? 'Retry to check'
              : !isHold && isGenerated ? 'Split wallet'
              : !isHold && isPrimary ? 'Primary wallet'
              : isHold ? 'Available to withdraw' : 'Auto-routed'}
          </p>
        </div>
        <div className="bucket-allocation-track" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.min(100, pct) / 100})` }} />
        </div>
      </div>

      <div className="bucket-card-goal-slot">
        {hasGoal ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <p style={{ color: 'var(--text-2)', fontSize: 11 }}>Goal ${formatUsdc(goal)}</p>
              <p className="font-mono" style={{ color: 'var(--text-2)', fontSize: 11 }}>{progressPct}%</p>
            </div>
            <div className="bucket-goal-track">
              <span
                style={{ transform: `scaleX(${progressRaw / 100})` }}
                role="progressbar"
                aria-valuenow={Math.round(progressRaw)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${progressPct}% of goal`}
              />
            </div>
          </>
        ) : (
          <p style={{ color: 'var(--text-3)', fontSize: 11 }}>No savings goal set</p>
        )}
      </div>

      <div className="bucket-card-footer">
        <div className="flex min-w-0 flex-1 gap-2">
          <ActionButton icon={<SquarePen size={15} />} label="Edit" onClick={onEdit} />
          {isLocked && onWithdrawLock ? (
            <ActionButton
              icon={<ArrowDownToLine size={15} />}
              label="Withdraw"
              onClick={onWithdrawLock}
              disabled={(lock?.balance ?? 0n) === 0n}
            />
          ) : lockConflict || lockForeign || lockUnavailable ? (
            // Never offer a card-level withdrawal for a lock we cannot attribute
            // unambiguously to this bucket, or cannot verify at all.
            <ActionButton
              icon={<ArrowDownToLine size={15} />}
              label="Withdraw"
              onClick={() => {}}
              disabled
            />
          ) : isGenerated && onSendFromWallet ? (
            <ActionButton icon={<Send size={15} />} label="Send" onClick={onSendFromWallet} />
          ) : (
            <ActionButton
              icon={<ArrowDownToLine size={15} />}
              label="Withdraw"
              onClick={onWithdraw}
              disabled={!canWithdraw}
            />
          )}
        </div>

        <details ref={menuRef} className="bucket-card-menu">
          <summary className="bucket-menu-summary" aria-label={`More actions for ${bucket.name}`}>
            <MoreHorizontal size={18} />
          </summary>
          <div className="bucket-menu-popover">
            <button type="button" onClick={() => runMenuAction(onSchedule)}>
              <CalendarClock size={15} /> Schedule
            </button>
            <button type="button" onClick={() => runMenuAction(onSetGoal)}>
              <Target size={15} /> {hasGoal ? 'Edit goal' : 'Set goal'}
            </button>
            <span className="bucket-menu-divider" />
            <button type="button" className="is-danger" onClick={() => runMenuAction(onDelete)}>
              <Trash2 size={15} /> Delete bucket
            </button>
          </div>
        </details>
      </div>
    </article>
  )
}
