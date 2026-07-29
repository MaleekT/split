// Per-bucket generated wallets: an address Split derives for a wallet-bucket, so
// a user can have a real auto-send destination without owning a second wallet.
//
// Each bucket gets its OWN key. They are never shared, because two buckets sharing
// a destination would both mix their funds and double-count in the dashboard total.
//
// Why an index and not the bucket ID: `nextBucketId` is private in Split.sol with
// no getter, and addBucket takes the destination as an INPUT, so the bucket ID only
// exists after creation. Deriving from it would be circular. The index is granted
// by an atomic database reservation instead (see /api/bucket-wallets/reserve).
//
// Imports are limited to `viem` on purpose, exactly as lib/vault.ts and
// lib/claim-math.ts are: no relative project imports, so this runs directly under
// `node --test` (raw Node cannot resolve extensionless relative paths).

import { keccak256, concat, toBytes, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ── EIP-712 signing payload ───────────────────────────────────────────────────
//
// A third domain, distinct from BOTH the Vault domain (lib/vault.ts) and the
// stealth personal_sign message (lib/stealth.ts). Like the Vault it carries no
// `verifyingContract`: this signature authorises nothing on-chain, it only seeds
// keys, and omitting it keeps the domain structurally unable to collide with
// USDC's EIP-3009 payment-authorisation domain.
export const BUCKET_WALLET_EIP712_NAME    = 'Split Bucket Wallets'
export const BUCKET_WALLET_EIP712_VERSION = '1'

export const BUCKET_WALLET_EIP712_TYPES = {
  BucketWallets: [
    { name: 'purpose', type: 'string' },
    { name: 'version', type: 'string' },
  ],
} as const

export const BUCKET_WALLET_EIP712_MESSAGE = {
  purpose: 'Derive my Split bucket wallet keys. This signature never leaves my device.',
  version: BUCKET_WALLET_EIP712_VERSION,
} as const

/**
 * The exact payload to hand to signTypedData. One signature covers every bucket:
 * individual addresses are separated by the index mixed in at derivation time, not
 * by signing again per bucket.
 */
export function bucketWalletTypedData(chainId: number) {
  return {
    domain: {
      name:    BUCKET_WALLET_EIP712_NAME,
      version: BUCKET_WALLET_EIP712_VERSION,
      chainId,
    },
    types:       BUCKET_WALLET_EIP712_TYPES,
    primaryType: 'BucketWallets' as const,
    message:     BUCKET_WALLET_EIP712_MESSAGE,
  }
}

// Domain tag bound to this purpose, distinct from the Vault's tag, so an identical
// signature under another scheme could never yield the same key.
const BUCKET_WALLET_KEY_TAG = 'split.bucket-wallet.v1'

// '0x' + 65 bytes (r,s,v) as hex = 2 + 130.
const MIN_SIGNATURE_LENGTH = 132

/** Highest index this module will derive. Guards against a runaway scan loop. */
export const MAX_DERIVATION_INDEX = 100_000

function assertValidIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_DERIVATION_INDEX) {
    throw new Error(`Invalid bucket wallet derivation index: ${index}`)
  }
}

/**
 * Derive a bucket wallet's private key from the user's typed-data signature and
 * the derivation index granted to that bucket. Deterministic, so the same wallet
 * and index always yield the same address - which is what makes these recoverable
 * on any device, and recoverable even if the database is lost.
 */
export function deriveBucketWalletKey(signature: Hex, index: number): Hex {
  // A secp256k1 signature is 65 bytes (r,s,v) = 130 hex chars + the 0x prefix.
  // Reject anything shorter: a truncated or stubbed value would still hash to a
  // usable-looking key, but one seeded from almost no entropy, leaving the wallet
  // trivially derivable by anyone.
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < MIN_SIGNATURE_LENGTH) {
    throw new Error('Invalid signature for bucket wallet derivation')
  }
  assertValidIndex(index)
  // The index is a separate tagged field rather than appended text, so index 1
  // followed by 23 can never produce the same preimage as index 12 followed by 3.
  return keccak256(concat([
    toBytes(BUCKET_WALLET_KEY_TAG),
    toBytes(':'),
    toBytes(String(index)),
    toBytes(':'),
    toBytes(signature),
  ]))
}

/** The bucket wallet's address for a signature and index. Pure; no network access. */
export function deriveBucketWalletAddress(signature: Hex, index: number): `0x${string}` {
  return privateKeyToAccount(deriveBucketWalletKey(signature, index)).address
}

export interface RecoveredBucketWallet {
  /** The on-chain bucket destination that was matched. */
  readonly address: `0x${string}`
  readonly index:   number
}

export interface BucketWalletRecovery {
  readonly found: RecoveredBucketWallet[]
  /**
   * Destinations the scan could not attribute to any index within `maxIndex`.
   * These are EITHER ordinary pasted addresses OR generated wallets sitting past
   * the scan bound - and this function cannot tell which.
   *
   * Callers must surface these as unresolved. Rendering one as an ordinary manual
   * bucket is the silent failure this whole design exists to avoid: its send
   * action would vanish and its funds would look stranded with no explanation.
   */
  readonly unresolved: `0x${string}`[]
  /** True when the scan hit its bound with destinations still outstanding. */
  readonly hitBound: boolean
}

/**
 * Default scan bound. Set from measurement, not taste: derivation costs ~1.5ms
 * (secp256k1 point multiplication dominates), so this is ~15s in the worst case -
 * and that cost is only paid in the rare deep scan where the metadata table is
 * gone AND a destination is unattributable. A full match exits early, so the
 * normal case is a handful of derivations and a few milliseconds.
 *
 * Deliberately generous rather than configurable: with MAX_BUCKETS = 10 on-chain
 * and orphaned reservations reclaimed, reaching index 10,000 would take ~10,000
 * lifetime generated-bucket creations. That is effectively unbounded margin with
 * no extra state or mechanism to get wrong.
 *
 * The safety property is NOT "the ceiling is high enough" - no ceiling can
 * guarantee that - but "nothing is ever mislabelled": whatever the bound,
 * unmatched destinations come back as `unresolved`, never as "not generated".
 */
export const DEFAULT_SCAN_BOUND = 10_000

// Derivations between yields to the event loop. A deep scan is ~15s of CPU, which
// run synchronously would freeze the tab outright; yielding keeps the page
// responsive at a cost of a few hundred milliseconds across the whole scan.
const YIELD_EVERY = 512

/**
 * Recover which derivation index produced each of `destinations`, without the
 * database. Used when the metadata table is lost or unavailable.
 *
 * Pass `maxIndex` when the table IS available (its highest recorded index): the
 * scan then covers exactly the used range and no ceiling applies in practice.
 *
 * Scanning is linear from 0 and does NOT stop on a run of misses. Deleted buckets
 * consume indices permanently, so a long-lived account legitimately has large gaps
 * between live destinations - an early-exit-on-misses heuristic would skip right
 * past a real bucket sitting beyond the gap.
 *
 * Async because a deep scan is seconds of CPU: it yields periodically so the tab
 * stays responsive instead of locking up.
 */
export async function recoverBucketWalletIndices(
  signature: Hex,
  destinations: readonly `0x${string}`[],
  maxIndex: number = DEFAULT_SCAN_BOUND,
): Promise<BucketWalletRecovery> {
  assertValidIndex(maxIndex)

  const wanted = new Map<string, `0x${string}`>()
  for (const d of destinations) wanted.set(d.toLowerCase(), d)

  const found: RecoveredBucketWallet[] = []

  for (let index = 0; index <= maxIndex && wanted.size > 0; index++) {
    const candidate = deriveBucketWalletAddress(signature, index).toLowerCase()
    const hit = wanted.get(candidate)
    if (hit) {
      found.push({ address: hit, index })
      wanted.delete(candidate)
    }
    if (index > 0 && index % YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  return { found, unresolved: [...wanted.values()], hitBound: wanted.size > 0 }
}
