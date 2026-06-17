export interface BucketLike {
  bps: number
}

/** User-facing % input → integer BPS stored on-chain. Output is always an integer. */
export const pctToBPS = (pct: number): number => Math.round(pct * 100)

/** Integer BPS → human-readable %. FOR DISPLAY ONLY — never feed into arithmetic or contract args. */
export const bpsToPCT = (bps: number): number => bps / 100

/** Sum of all BPS values. Uses integer addition only. */
export const sumBPS = (buckets: BucketLike[]): number =>
  buckets.reduce((acc, b) => acc + b.bps, 0)

/** True only when buckets total exactly 10,000 BPS (100%). */
export const isValidBPS = (buckets: BucketLike[]): boolean =>
  sumBPS(buckets) === 10_000

/** Remaining BPS available to allocate. */
export const remainingBPS = (buckets: BucketLike[]): number =>
  10_000 - sumBPS(buckets)
