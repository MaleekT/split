// Pure share math for Private Claim. Mirrors the on-chain Split._split
// floor-division-plus-remainder rule EXACTLY so a private, off-contract claim
// distributes a stealth payment across the recipient's buckets identically to
// what depositFor would have done, but by sending transfers directly from the
// stealth address to each bucket destination (never touching the Split contract).
//
// No SDK / no wallet imports here on purpose: this is unit-testable in isolation.

const ZERO = '0x0000000000000000000000000000000000000000'
const BPS_TOTAL = 10_000n

export interface ClaimBucket {
  readonly bps:         number         // uint16, 0..10000
  readonly destination: `0x${string}`  // ZERO = hold bucket
  readonly active:      boolean
}

export interface ClaimTransfer {
  readonly destination: `0x${string}`
  readonly amount:      bigint
}

export interface ClaimPlan {
  // One transfer per active auto-send bucket (to that bucket's destination).
  readonly autoSends:  readonly ClaimTransfer[]
  // Combined amount routed to the user's main address: every hold bucket's share
  // (hold buckets have no external destination), plus any floor remainder when
  // there is no hold bucket to absorb it. Zero when there is nothing to send there.
  readonly toMainAddress: bigint
}

/**
 * Compute how to distribute `amount` (6-decimal USDC) across `buckets`, mirroring
 * Split._split: share_i = floor(amount * bps_i / 10000), and the floor remainder
 * is added to the LAST hold bucket (matching the contract's `lastHoldIdx`). Hold
 * shares are aggregated to the main address; auto-send shares go to their bucket
 * destinations. Zero-value shares produce no transfer.
 */
export function computeClaimPlan(buckets: readonly ClaimBucket[], amount: bigint): ClaimPlan {
  const active = buckets.filter((b) => b.active)

  // Per-bucket floored shares.
  const shares: bigint[] = active.map((b) => (amount * BigInt(b.bps)) / BPS_TOTAL)
  let allocated = 0n
  for (const s of shares) allocated += s
  let remainder = amount - allocated

  // Remainder to the last hold bucket, exactly as the contract does.
  let lastHoldIdx = -1
  active.forEach((b, i) => { if (b.destination === ZERO) lastHoldIdx = i })
  if (remainder > 0n && lastHoldIdx >= 0) {
    shares[lastHoldIdx] = (shares[lastHoldIdx] ?? 0n) + remainder
    remainder = 0n
  }

  // Map shares to transfers.
  const autoSends: ClaimTransfer[] = []
  let toMainAddress = 0n
  active.forEach((b, i) => {
    const share = shares[i] ?? 0n
    if (share === 0n) return
    if (b.destination === ZERO) toMainAddress += share
    else autoSends.push({ destination: b.destination, amount: share })
  })

  // Any leftover remainder (no hold bucket existed) is not lost: route it to the
  // main address so a Private Claim never strands floor dust at the stealth key.
  toMainAddress += remainder

  return { autoSends, toMainAddress }
}

/** Number of on-chain transfers a Private Claim plan will make (for gas budgeting). */
export function claimTransferCount(plan: ClaimPlan): number {
  return plan.autoSends.length + (plan.toMainAddress > 0n ? 1 : 0)
}
