// Allocation arithmetic for the Add Bucket flow.
//
// Split requires bucket allocations to total exactly 10000 bps, and addBucket
// reverts with ExceedsBPS the moment the sum would pass it. The UI uses this to
// work out how much must be freed up first, so an over-allocation is caught while
// the form is still open rather than on submit.
//
// No imports on purpose, like lib/claim-math.ts: this stays unit-testable under
// raw Node, which cannot resolve extensionless relative imports.

export const BPS_TOTAL = 10_000

/**
 * Basis points that must be freed elsewhere for `newBps` to fit alongside
 * `currentTotalBps`. Zero when there is already room.
 */
export function bpsToFree(currentTotalBps: number, newBps: number): number {
  if (!Number.isFinite(currentTotalBps) || !Number.isFinite(newBps)) return 0
  return Math.max(0, currentTotalBps + newBps - BPS_TOTAL)
}

/**
 * Whether a single bucket can absorb the whole reduction on its own.
 *
 * Strictly greater, not >=: taking a bucket to 0% is a deletion, which is a
 * different action with different consequences (its balance is paid out), so it
 * is never done implicitly here.
 */
export function canAbsorbReduction(bucketBps: number, neededBps: number): boolean {
  return bucketBps > neededBps
}
