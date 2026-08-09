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
  // One transfer per active auto-send bucket (to that bucket's destination), plus
  // one to the Private Vault when a hold portion exists and a Vault is set up.
  readonly autoSends:  readonly ClaimTransfer[]
  // Hold-bucket share (plus any floor remainder) that has nowhere legitimate to go
  // because no Vault exists yet. NOT sent: it stays at the stealth address, where
  // the next scan re-detects it and it becomes claimable once a Vault is created.
  //
  // This deliberately replaces the old `toMainAddress` fallback. Pushing hold
  // funds to the user's public main address partially deanonymised the very
  // payment the private path exists to protect.
  readonly deferredRaw: bigint
}

/**
 * Compute how to distribute `amount` (6-decimal USDC) across `buckets`, mirroring
 * Split._split: share_i = floor(amount * bps_i / 10000), and the floor remainder
 * is added to the LAST hold bucket (matching the contract's `lastHoldIdx`).
 *
 * Auto-send shares go to their bucket destinations. Hold shares go to `vaultAddress`
 * when one is set up, and are otherwise deferred (left at the stealth address) -
 * never routed to the main address. Zero-value shares produce no transfer.
 */
export function computeClaimPlan(
  buckets: readonly ClaimBucket[],
  amount: bigint,
  vaultAddress: `0x${string}` | null = null,
): ClaimPlan {
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

  // Map shares to transfers. Hold-bucket shares are aggregated first, then routed
  // in one transfer to the Vault (or deferred), rather than one transfer each.
  const autoSends: ClaimTransfer[] = []
  let holdTotal = 0n
  active.forEach((b, i) => {
    const share = shares[i] ?? 0n
    if (share === 0n) return
    if (b.destination === ZERO) holdTotal += share
    else autoSends.push({ destination: b.destination, amount: share })
  })

  // Leftover remainder only survives when no hold bucket existed to absorb it.
  // It follows the hold portion: to the Vault, or deferred. Never to the main
  // address, which is what the removed fallback did.
  holdTotal += remainder

  if (holdTotal > 0n && vaultAddress !== null) {
    return { autoSends: [...autoSends, { destination: vaultAddress, amount: holdTotal }], deferredRaw: 0n }
  }
  return { autoSends, deferredRaw: holdTotal }
}

/** Number of on-chain transfers a Private Claim plan will make (for gas budgeting). */
export function claimTransferCount(plan: ClaimPlan): number {
  // Every transfer now lives in autoSends, including the Vault one. Deferred funds
  // move nothing, so they cost no gas - which is what makes a partial claim cheaper
  // than a full one and lets the reserve be sized to actual work.
  return plan.autoSends.length
}

// ── Arc gas economics ─────────────────────────────────────────────────────────
// On Arc a stealth address's USDC balance IS its native gas balance: one pot,
// native 18-decimal and the USDC facade 6-decimal (factor 1e12). Every claim must
// therefore leave a gas reserve funded from the received amount, which means a
// small enough payment can never be claimed at all - the reserve exceeds it.
// Those payments are dust: real funds, permanently stuck, and showing a live
// Claim button for them only produces a failed transaction.

export const NATIVE_PER_USDC = 10n ** 12n
export const GAS_MARGIN      = 2n        // 100% safety on estimated gas
export const APPROVE_GAS     = 60_000n   // USDC facade approve
export const DEPOSIT_GAS     = 450_000n  // depositFor with up to 10 buckets
export const TRANSFER_GAS    = 90_000n   // one USDC facade transfer

/** Cheapest claim path: Quick Claim, an approve plus a depositFor. */
export const QUICK_CLAIM_GAS = APPROVE_GAS + DEPOSIT_GAS

/** Gas reserve for `gasUnits` of work, expressed in 6-decimal USDC units. */
export function claimReserveRaw(gasPriceWei: bigint, gasUnits: bigint = QUICK_CLAIM_GAS): bigint {
  const costWei = gasUnits * gasPriceWei * GAS_MARGIN
  return (costWei + NATIVE_PER_USDC - 1n) / NATIVE_PER_USDC
}

/**
 * Maximum token balance consumed by a transaction's upfront gas reservation.
 * Arc exposes the gas token through a 6-decimal USDC facade, so round UP: one
 * raw unit too little makes the ERC-20 call see a balance below its argument.
 */
export function transactionFeeReserveRaw(gasLimit: bigint, maxFeePerGas: bigint): bigint {
  const costWei = gasLimit * maxFeePerGas
  return (costWei + NATIVE_PER_USDC - 1n) / NATIVE_PER_USDC
}

/**
 * Whether a received amount is too small to ever claim. Deliberately measured
 * against the CHEAPEST path, so nothing is written off as dust while some claim
 * mode could still move it. Mirrors the `balance <= reserve` guard the claim
 * executors enforce, so the UI and the executor agree on what is claimable.
 */
export function isDustAmount(amountRaw: bigint, reserveRaw: bigint): boolean {
  return amountRaw <= reserveRaw
}
