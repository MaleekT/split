import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BucketCard } from '../bucket-card'
import type { SplitBucket } from '@/lib/contracts'

// These cover the states that are FINANCIALLY MISLEADING if they render wrongly.
// A lock owned by somebody else must never look like the user's own, a shared
// lock must never let a card claim its balance exclusively, and an RPC failure
// must never be presented as a verified ordinary address.

const LOCK_ADDR = '0x53D13BFd25b65fb1fD6B0e56a67D037cd7Ab7513'
const ZERO      = '0x0000000000000000000000000000000000000000'
const YEAR_AWAY = BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400)

function bucket(over: Partial<SplitBucket> = {}): SplitBucket {
  return {
    id: 1n, name: 'Savings', bps: 5_000,
    destination: LOCK_ADDR as `0x${string}`,
    balance: 0n, active: true,
    ...over,
  } as SplitBucket
}

function renderCard(props: Partial<Parameters<typeof BucketCard>[0]> = {}) {
  return render(
    <BucketCard
      bucket={bucket()}
      colorIndex={0}
      onEdit={vi.fn()}
      onWithdraw={vi.fn()}
      onSchedule={vi.fn()}
      onSetGoal={vi.fn()}
      onDelete={vi.fn()}
      {...props}
    />,
  )
}

const withdrawButton = () =>
  screen.getAllByRole('button').find((b) => /withdraw/i.test(b.textContent ?? ''))

describe('BucketCard lock states', () => {
  it('shows a locked bucket as Locked with its own balance, not routed totals', () => {
    renderCard({
      routedTotal: 999_000_000n, // cumulative routed would over-report
      lock: { classification: 'ELIGIBLE', balance: 25_000_000n, unlockedNow: false, unlockAt: YEAR_AWAY },
      onWithdrawLock: vi.fn(),
    })
    expect(screen.getByText('Locked')).toBeInTheDocument()
    // Rendered in both the USDC figure and the ≈USD line, hence getAllByText.
    expect(screen.getAllByText(/25\.00/).length).toBeGreaterThan(0)
    // The point of the assertion: the cumulative routed total is NOT the source.
    expect(screen.queryByText(/999/)).not.toBeInTheDocument()
  })

  it('shows an unlocked lock as ready and enables withdrawal', () => {
    renderCard({
      lock: { classification: 'ELIGIBLE', balance: 5_000_000n, unlockedNow: true },
      onWithdrawLock: vi.fn(),
    })
    expect(screen.getByText('Unlocked')).toBeInTheDocument()
    expect(withdrawButton()).not.toBeDisabled()
  })

  it('never presents a FOREIGN lock as the user’s own, and refuses withdrawal', () => {
    renderCard({
      lock: { classification: 'FOREIGN', balance: 40_000_000n, unlockedNow: true },
    })
    expect(screen.getByText('Not your lock')).toBeInTheDocument()
    expect(screen.getByText(/owned by another account/i)).toBeInTheDocument()
    expect(screen.queryByText('Locked')).not.toBeInTheDocument()
    expect(withdrawButton()).toBeDisabled()
  })

  it('refuses card withdrawal for a lock shared by two buckets', () => {
    renderCard({
      lock: { classification: 'CONFLICT', balance: 10_000_000n, unlockedNow: true },
    })
    expect(screen.getByText('Shared lock')).toBeInTheDocument()
    expect(screen.getByText(/shared with another bucket/i)).toBeInTheDocument()
    expect(withdrawButton()).toBeDisabled()
  })

  it('says verification failed rather than calling it an ordinary address', () => {
    renderCard({ lock: { classification: 'UNAVAILABLE' } })
    expect(screen.getByText('Could not verify')).toBeInTheDocument()
    expect(screen.getByText(/retry to check/i)).toBeInTheDocument()
    expect(withdrawButton()).toBeDisabled()
  })

  it('disables withdrawal on an eligible but empty lock', () => {
    renderCard({
      lock: { classification: 'ELIGIBLE', balance: 0n, unlockedNow: true },
      onWithdrawLock: vi.fn(),
    })
    expect(withdrawButton()).toBeDisabled()
  })

  it('counts down to the unlock date when no target is set', () => {
    renderCard({
      lock: {
        classification: 'ELIGIBLE', balance: 1_000_000n, unlockedNow: false,
        unlockAt: BigInt(Math.floor(Date.now() / 1000) + 3 * 86_400),
      },
      onWithdrawLock: vi.fn(),
    })
    expect(screen.getByText(/unlocks in \d+ days/i)).toBeInTheDocument()
  })

  it('shows progress toward the target in preference to a distant date', () => {
    renderCard({
      lock: {
        classification: 'ELIGIBLE', balance: 312_000_000n, unlockedNow: false,
        unlockAt: YEAR_AWAY, target: 500_000_000n, targetMet: false,
      },
      onWithdrawLock: vi.fn(),
    })
    expect(screen.getByText(/312\.00 of 500\.00/)).toBeInTheDocument()
  })

  it('leaves an ordinary hold bucket completely unchanged', () => {
    renderCard({ bucket: bucket({ destination: ZERO as `0x${string}`, balance: 7_000_000n }) })
    expect(screen.getByText('Holds in contract')).toBeInTheDocument()
    expect(screen.getByText(/available to withdraw/i)).toBeInTheDocument()
    expect(withdrawButton()).not.toBeDisabled()
  })
})
