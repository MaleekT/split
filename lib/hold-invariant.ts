// The hold-bucket invariant, in ONE place so the rule cannot drift between the
// four modals that need it.
//
// Why this exists, verified in Split.sol: `_split` floor-divides every bucket's
// share and credits the leftover only inside
//
//     if (remaining > 0 && lastHoldIdx != type(uint256).max) { ... }
//
// With no active HOLD bucket, `lastHoldIdx` stays at its sentinel and `remaining`
// is credited to nothing. The USDC is already inside the contract from
// safeTransferFrom, and Split has no sweep, rescue, skim or recover function, so
// that dust is stranded permanently.
//
// Magnitude: each active bucket loses at most one raw unit to flooring, so the
// remainder is bounded by (activeBuckets - 1) raw units. With MAX_BUCKETS = 10
// that is at most 9 units, or 0.000009 USDC, per deposit. Small, permanent, and
// worth a warning rather than a prohibition.
//
// POLICY A (chosen): nothing is blocked. This module classifies the situation and
// the UI warns, acknowledges, and offers a zero-BPS dust-catcher bucket as the
// remedy. Blocking would remove a capability the product already has, and direct
// contract calls bypass any UI rule anyway.
//
// NOT CONTRACT-ENFORCED. Direct addBucket / updateBucket / deleteBucket calls
// bypass this entirely, and nothing here should ever be described otherwise.
//
// No relative project imports, so this runs under raw `node --test`.

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const BPS_TOTAL    = 10_000

export interface InvariantBucket {
  readonly id:          bigint
  readonly bps:         number
  readonly destination: string
  readonly active:      boolean
}

export type HoldInvariantState =
  /** Deposit-ready and at least one active hold bucket. Nothing to say. */
  | 'OK'
  /**
   * Total BPS is not exactly 10,000, so `_split` reverts InvalidBPSTotal before
   * any rounding can happen. Showing a dust warning here would fire on every
   * legitimate mid-setup state, which is the defect this state exists to avoid.
   */
  | 'INCOMPLETE'
  /** The proposed change would produce a deposit-ready all-destination set. */
  | 'WOULD_STRAND'
  /** Already all-destination and deposit-ready, with no change proposed. */
  | 'DEGRADED'

export interface HoldInvariantResult {
  readonly state:         HoldInvariantState
  readonly totalBps:      number
  readonly hasHoldBucket: boolean
}

/**
 * A change to evaluate BEFORE it is submitted. Omit to classify the current set.
 * `remove` and `upsert` may be combined (an edit is an upsert; a delete is a
 * remove; creating is an upsert of a new id).
 */
export interface ProposedChange {
  readonly remove?: bigint
  readonly upsert?: InvariantBucket
}

function isHold(b: InvariantBucket): boolean {
  return b.active && b.destination.toLowerCase() === ZERO_ADDRESS
}

/** Apply a proposed change without mutating the caller's array. */
function resultingSet(
  buckets: readonly InvariantBucket[],
  change?: ProposedChange,
): InvariantBucket[] {
  let next = buckets.slice()
  if (change?.remove !== undefined) {
    next = next.filter((b) => b.id !== change.remove)
  }
  if (change?.upsert) {
    const up = change.upsert
    const at = next.findIndex((b) => b.id === up.id)
    next = at === -1 ? [...next, up] : next.map((b) => (b.id === up.id ? up : b))
  }
  return next
}

export function evaluateHoldInvariant(
  buckets: readonly InvariantBucket[],
  change?: ProposedChange,
): HoldInvariantResult {
  const next     = resultingSet(buckets, change)
  const active   = next.filter((b) => b.active)
  const totalBps = active.reduce((sum, b) => sum + b.bps, 0)
  const hasHoldBucket = active.some(isHold)

  // Not deposit-ready: `_split` reverts before rounding is reachable, so there is
  // no dust to warn about yet regardless of destinations.
  if (totalBps !== BPS_TOTAL) {
    return { state: 'INCOMPLETE', totalBps, hasHoldBucket }
  }
  if (hasHoldBucket) {
    return { state: 'OK', totalBps, hasHoldBucket }
  }
  return {
    state: change ? 'WOULD_STRAND' : 'DEGRADED',
    totalBps,
    hasHoldBucket,
  }
}

/**
 * The remedy: a hold bucket at ZERO bps.
 *
 * `Split.addBucket` has no zero-BPS guard, and `_split` sets `lastHoldIdx` for
 * ANY active zero-destination bucket regardless of its bps. So a zero-BPS hold
 * bucket absorbs the rounding remainder while taking no allocation at all,
 * leaving an existing 100% split completely undisturbed because `_sumBPS` is
 * unaffected. It costs one of the ten bucket slots and nothing else.
 *
 * The ordinary creation flow still rejects a zero allocation, where it is almost
 * always a mistake. This is the one labelled path that allows it.
 */
export const DUST_CATCHER_BPS  = 0
export const DUST_CATCHER_NAME = 'Rounding'

export function dustCatcherArgs(): { name: string; bps: number; destination: string } {
  return { name: DUST_CATCHER_NAME, bps: DUST_CATCHER_BPS, destination: ZERO_ADDRESS }
}

/** Upper bound on dust a single deposit can strand, in raw 6-decimal units. */
export function maxStrandedPerDeposit(activeBucketCount: number): number {
  return activeBucketCount > 0 ? activeBucketCount - 1 : 0
}
