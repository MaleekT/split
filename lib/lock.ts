// Pure math and state logic for locked buckets. Mirrors BucketLock.sol EXACTLY so
// the figure shown before signing is the figure the contract charges.
//
// No relative project imports and no SDK imports on purpose, exactly like
// lib/claim-math.ts and lib/vault.ts: this must run directly under raw Node
// (`node --test`), which cannot resolve extensionless relative paths.

export const BPS_TOTAL   = 10_000n
/** Exactly 10%. Mirrors BucketLock.PENALTY_BPS, which is a constant, not config. */
export const PENALTY_BPS = 1_000n

/**
 * Ceiling division, mirroring `Math.mulDiv(amount, PENALTY_BPS, BPS_TOTAL, Ceil)`.
 *
 * Ceiling rather than floor is what guarantees a non-zero penalty for every
 * amount >= 1. With floor, any amount under 10 raw units would break its lock for
 * free. A minimum lock amount would NOT fix that, because the withdrawal amount
 * is chosen independently of the locked principal.
 *
 * BigInt throughout, so there is no overflow to mirror: the contract needs
 * mulDiv's 512-bit intermediate only because Solidity's uint256 would wrap.
 */
export function penaltyFor(amount: bigint): bigint {
  if (amount <= 0n) return 0n
  return (amount * PENALTY_BPS + BPS_TOTAL - 1n) / BPS_TOTAL
}

export interface Quote {
  readonly penalty: bigint
  readonly net:     bigint
}

/**
 * Hypothetical arithmetic, mirroring `quotePenalty`. Does NOT consider balance or
 * unlock state, and does NOT reject dust: a one-unit amount quotes as
 * `{ penalty: 1n, net: 0n }` rather than throwing, because this is a calculator
 * and not a gate.
 *
 * Used by the migration confirmation, which must quote a cost BEFORE the lock
 * holds anything. Callers must present it conditionally: it cannot know whether
 * the lock will still be locked when a withdrawal actually happens.
 */
export function quotePenalty(amount: bigint): Quote {
  const penalty = penaltyFor(amount)
  return { penalty, net: amount - penalty }
}

/** True when withdrawing `amount` early would leave the owner with nothing. */
export function isDustWithdrawal(amount: bigint): boolean {
  return amount > 0n && penaltyFor(amount) >= amount
}

export interface LockState {
  /** Unix seconds. Always non-zero: the factory requires a date. */
  readonly unlockAt:  bigint
  /** Raw 6-decimal units. Zero means no target condition, i.e. date-only. */
  readonly target:    bigint
  /** The latched flag read from chain. Monotonic; never returns to false. */
  readonly targetMet: boolean
  /** Live token balance of the lock. */
  readonly balance:   bigint
}

/**
 * Mirrors `BucketLock.isUnlocked()`, including the live-balance check.
 *
 * The live balance is checked as well as the latch, so a lock that has reached
 * its target reads as unlocked even when nobody has called poke() yet. The latch
 * only exists so that fact survives a withdrawal that drops the balance back
 * below the target.
 *
 * Documented consequence of live-balance semantics: anyone can send USDC to a
 * lock and push it over its target, unlocking it early. That is not a fund-loss
 * path, since only the owner can withdraw; a third party can remove someone's
 * penalty, never take their money.
 */
export function isUnlocked(state: LockState, nowSeconds: bigint): boolean {
  if (state.unlockAt !== 0n && nowSeconds >= state.unlockAt) return true
  if (state.targetMet) return true
  if (state.target !== 0n && state.balance >= state.target) return true
  return false
}

export interface WithdrawPreview {
  readonly net:     bigint
  readonly penalty: bigint
  readonly early:   boolean
  /**
   * Set when the contract would revert. The UI must disable submission and show
   * this, so the user never reaches a wallet prompt for a doomed transaction.
   */
  readonly error:   'InvalidAmount' | 'InsufficientBalance' | 'PenaltyExceedsAmount' | null
}

/**
 * Mirrors `previewWithdraw` including every revert, so the client and the chain
 * agree. This is a local prediction: `previewWithdraw` on-chain is the
 * current-block truth, and the mined transaction is authoritative above both.
 */
export function previewWithdraw(
  state: LockState,
  amount: bigint,
  nowSeconds: bigint,
): WithdrawPreview {
  if (amount <= 0n)          return { net: 0n, penalty: 0n, early: false, error: 'InvalidAmount' }
  if (amount > state.balance) return { net: 0n, penalty: 0n, early: false, error: 'InsufficientBalance' }

  const early = !isUnlocked(state, nowSeconds)
  if (!early) return { net: amount, penalty: 0n, early: false, error: null }

  const penalty = penaltyFor(amount)
  if (penalty >= amount) return { net: 0n, penalty, early: true, error: 'PenaltyExceedsAmount' }
  return { net: amount - penalty, penalty, early: true, error: null }
}

/** Seconds until the date unlock, or 0 once it has passed. */
export function secondsUntilUnlock(state: LockState, nowSeconds: bigint): bigint {
  if (state.unlockAt === 0n || nowSeconds >= state.unlockAt) return 0n
  return state.unlockAt - nowSeconds
}

/** Raw units still needed to hit the target, or 0 when met or not configured. */
export function remainingToTarget(state: LockState): bigint {
  if (state.target === 0n || state.targetMet) return 0n
  return state.balance >= state.target ? 0n : state.target - state.balance
}

/** Minimum lock duration enforced by BucketLockFactory.MIN_DURATION. */
export const MIN_LOCK_DURATION_SECONDS = 86_400n

/** Mirrors the factory's date validation so the form fails before the wallet does. */
export function validateUnlockDate(
  unlockAt: bigint,
  nowSeconds: bigint,
): 'DateRequired' | 'UnlockTooSoon' | null {
  if (unlockAt === 0n) return 'DateRequired'
  if (unlockAt < nowSeconds + MIN_LOCK_DURATION_SECONDS) return 'UnlockTooSoon'
  return null
}
