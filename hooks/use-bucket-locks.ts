'use client'

import { useCallback, useMemo } from 'react'
import { useAccount, useChainId } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { getAddress, isAddress } from 'viem'
import { publicClient } from '@/lib/arc'
import { USDC } from '@/lib/contracts'
import {
  bucketLockAbi, bucketLockFactoryAbi, trustedFactoryFor,
  type TrustedFactory,
} from '@/lib/lock-contracts'
import { isUnlocked, type LockState } from '@/lib/lock'

// ── Classification ───────────────────────────────────────────────────────────
//
// Six distinct states, never collapsed. FOREIGN and UNSUPPORTED reuse the
// ordinary-address layout in the UI but must never be DESCRIBED as ordinary, and
// UNAVAILABLE must never be downgraded to ORDINARY: an RPC failure is not
// evidence that something is not a lock.

export type LockClassification =
  | 'ELIGIBLE'     // trusted factory, owned by this user, right token, right chain
  | 'FOREIGN'      // a genuine lock owned by SOMEBODY ELSE
  | 'UNSUPPORTED'  // factory/token/version/treasury mismatch, or wrong chain
  | 'ORDINARY'     // not a lock from any trusted factory
  | 'UNAVAILABLE'  // could not verify right now; retryable
  | 'CONFLICT'     // duplicate destination across two or more live buckets

export interface ClassifiedLock {
  readonly address:        `0x${string}`
  readonly classification: LockClassification
  /** Null whenever the state could not be read. Never defaulted to zero. */
  readonly state:          LockState | null
  readonly unlockedNow:    boolean
}

/** Page size for orphan discovery. Bounded so a dashboard load stays cheap. */
export const LOCK_PAGE_SIZE = 10

const lc = (a: string): string => a.toLowerCase()

/**
 * Shape of one `allowFailure: true` multicall entry.
 *
 * These calls are built dynamically from a runtime-length address list, so viem
 * cannot infer per-entry return types. Typing the RESULT explicitly is honest
 * about that; casting the contracts array to `never` would erase the result type
 * too and hide genuine mistakes at every read site below.
 */
type CallResult =
  | { readonly status: 'success'; readonly result: unknown }
  | { readonly status: 'failure'; readonly error: unknown }

// ── Factory validation ───────────────────────────────────────────────────────

/**
 * Validate a pinned factory against what it actually reports on chain. ANY
 * mismatch, including the treasury, makes it unsupported and fails closed: a
 * factory whose treasury is not the one we expect is not a factory we understand.
 *
 * Tri-state on purpose. "Could not reach the chain" and "this factory reports the
 * wrong treasury" are different facts and must not collapse into one: the second
 * justifies an alarming warning, the first is a transient outage where claiming
 * anything about the factory would be a claim we cannot support.
 */
export type FactoryCheck = 'VALID' | 'MISMATCH' | 'UNAVAILABLE'

async function validateFactory(f: TrustedFactory): Promise<FactoryCheck> {
  let code: string | undefined
  try {
    code = await publicClient.getBytecode({ address: f.address })
  } catch {
    return 'UNAVAILABLE'
  }
  // A definite answer: nothing is deployed at a pinned address.
  if (!code || code === '0x') return 'MISMATCH'

  let results
  try {
    results = await publicClient.multicall({
      allowFailure: true,
      contracts: [
        { address: f.address, abi: bucketLockFactoryAbi, functionName: 'VERSION' },
        { address: f.address, abi: bucketLockFactoryAbi, functionName: 'token' },
        { address: f.address, abi: bucketLockFactoryAbi, functionName: 'treasury' },
        { address: f.address, abi: bucketLockFactoryAbi, functionName: 'PENALTY_BPS' },
      ] as const,
    })
  } catch {
    return 'UNAVAILABLE'
  }
  // A call that reverts against deployed code means the wrong interface, which is
  // a real mismatch; a call that could not be made at all is an outage. viem's
  // allowFailure cannot distinguish them, so treat a failed read conservatively
  // as UNAVAILABLE and let a retry settle it rather than accusing the factory.
  if (results.some((r) => r.status !== 'success')) return 'UNAVAILABLE'

  const [version, token, treasury, penaltyBps] = results.map((r) => r.result)
  const matches =
    version === f.version &&
    lc(token as string) === lc(f.token) &&
    lc(treasury as string) === lc(f.treasury) &&
    penaltyBps === f.penaltyBps

  return matches ? 'VALID' : 'MISMATCH'
}

export function useBucketLocks(bucketDestinations: readonly string[] = []) {
  const { address } = useAccount()
  const chainId     = useChainId()

  const factory = useMemo(() => trustedFactoryFor(chainId), [chainId])

  // Validated once per chain+factory. Cheap, cached, and the gate for everything
  // below: with no valid factory, nothing can be ELIGIBLE.
  const { data: factoryCheck, isLoading: factoryChecking, isError: factoryError } = useQuery({
    queryKey: ['lock-factory', chainId, factory?.address ?? null],
    enabled:  factory !== null,
    staleTime: 5 * 60_000,
    queryFn:  async (): Promise<FactoryCheck> =>
      (factory ? validateFactory(factory) : 'MISMATCH'),
  })

  /** Distinct, checksummed, non-zero destinations. Deduped case-insensitively. */
  const distinct = useMemo(() => {
    const seen = new Map<string, `0x${string}`>()
    for (const d of bucketDestinations) {
      if (!d || !isAddress(d)) continue
      const norm = lc(d)
      if (norm === '0x0000000000000000000000000000000000000000') continue
      if (!seen.has(norm)) seen.set(norm, getAddress(d))
    }
    return [...seen.values()]
  }, [bucketDestinations])

  /** Destinations appearing on more than one live bucket. */
  const duplicates = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of bucketDestinations) {
      if (!d || !isAddress(d)) continue
      const norm = lc(d)
      if (norm === '0x0000000000000000000000000000000000000000') continue
      counts.set(norm, (counts.get(norm) ?? 0) + 1)
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([a]) => a))
  }, [bucketDestinations])

  const {
    data: classified = new Map<string, ClassifiedLock>(),
    isLoading: locksLoading,
    refetch: refetchLocks,
  } = useQuery({
    queryKey: ['locks', chainId, address ?? null, distinct.map(lc).sort().join(','), factoryCheck],
    enabled:  distinct.length > 0 && !factoryChecking,
    refetchInterval: 30_000,
    // The tri-state is passed through whole. Collapsing it to a boolean here is
    // exactly how an RPC outage would masquerade as a misconfigured factory.
    queryFn: async () =>
      classifyAll(distinct, factory, factoryCheck ?? 'UNAVAILABLE', address, duplicates),
  })

  /**
   * Orphan discovery: eligible locks NOT attached to any live bucket.
   *
   * Bounded on purpose. Newest-first by walking `locksOfLength - 1` downwards,
   * one page unless the caller asks for more. A full historical scan on every
   * dashboard render is exactly what this design avoids, and it is also why
   * orphan balances are excluded from the headline total in v1.
   */
  const loadOrphans = useCallback(async (page = 0): Promise<ClassifiedLock[]> => {
    if (!factory || factoryCheck !== 'VALID' || !address) return []

    const total = await publicClient.readContract({
      address: factory.address, abi: bucketLockFactoryAbi,
      functionName: 'locksOfLength', args: [address],
    }) as bigint

    const end   = Number(total) - page * LOCK_PAGE_SIZE
    const start = Math.max(0, end - LOCK_PAGE_SIZE)
    if (end <= 0) return []

    const idx = Array.from({ length: end - start }, (_, i) => BigInt(end - 1 - i)) // newest first
    const addrs = await publicClient.multicall({
      allowFailure: true,
      contracts: idx.map((i) => ({
        address: factory.address, abi: bucketLockFactoryAbi,
        functionName: 'locksOfAt', args: [address, i],
      })),
    }) as readonly CallResult[]

    const attached = new Set(distinct.map(lc))
    const candidates = addrs
      .filter((r) => r.status === 'success')
      .map((r) => getAddress(r.result as string))
      .filter((a) => !attached.has(lc(a)))

    if (candidates.length === 0) return []
    const map = await classifyAll(candidates, factory, 'VALID', address, new Set())
    return [...map.values()].filter((l) => l.classification === 'ELIGIBLE')
  }, [factory, factoryCheck, address, distinct])

  return {
    factory,
    /** True only when a pinned factory validated. Everything else fails closed. */
    /** Only VALID unlocks lock-specific actions. Everything else fails closed. */
    factoryValid: factoryCheck === 'VALID',
    /** Exposed so the UI can say "could not check" instead of "misconfigured". */
    factoryCheck: factoryCheck ?? 'UNAVAILABLE',
    factoryChecking,
    factoryError,
    classified,
    locksLoading,
    refetchLocks,
    loadOrphans,
    classify: (dest: string): ClassifiedLock | undefined => classified.get(lc(dest)),
  }
}

// ── The classifier ───────────────────────────────────────────────────────────

async function classifyAll(
  addresses: readonly `0x${string}`[],
  factory: TrustedFactory | null,
  factoryCheck: FactoryCheck,
  user: `0x${string}` | undefined,
  duplicates: ReadonlySet<string>,
): Promise<Map<string, ClassifiedLock>> {
  const out = new Map<string, ClassifiedLock>()
  if (addresses.length === 0) return out

  const unavailable = (a: `0x${string}`): ClassifiedLock =>
    ({ address: a, classification: 'UNAVAILABLE', state: null, unlockedNow: false })

  // No valid factory on this chain: nothing can be proven to be a lock, and
  // saying "ordinary" would be a claim we cannot support. Only when the factory
  // is DEFINITELY absent for this chain is ORDINARY the honest answer.
  if (!factory) {
    for (const a of addresses) {
      out.set(lc(a), { address: a, classification: 'ORDINARY', state: null, unlockedNow: false })
    }
    return out
  }
  // A definite mismatch is a real accusation and renders as UNSUPPORTED. An
  // outage is not evidence of anything, so it renders as UNAVAILABLE and stays
  // retryable rather than telling the user their factory is misconfigured.
  if (factoryCheck !== 'VALID') {
    const classification: LockClassification =
      factoryCheck === 'MISMATCH' ? 'UNSUPPORTED' : 'UNAVAILABLE'
    for (const a of addresses) {
      out.set(lc(a), { address: a, classification, state: null, unlockedNow: false })
    }
    return out
  }

  // One batched round trip for provenance, then one for state. allowFailure so a
  // single bad entry never discards its siblings.
  let provenance: readonly CallResult[]
  try {
    provenance = await publicClient.multicall({
      allowFailure: true,
      contracts: addresses.map((a) => ({
        address: factory.address, abi: bucketLockFactoryAbi,
        functionName: 'isLock', args: [a],
      })),
    }) as readonly CallResult[]
  } catch {
    for (const a of addresses) out.set(lc(a), unavailable(a))
    return out
  }

  const locks: `0x${string}`[] = []
  addresses.forEach((a, i) => {
    const r = provenance[i]
    if (!r || r.status !== 'success') { out.set(lc(a), unavailable(a)); return }
    if (r.result === true) locks.push(a)
    // Provenance says this factory did not create it. That is a definite answer,
    // so ORDINARY is honest here. A directly deployed BucketLock lands here too,
    // which is the intended "unsupported by the product" outcome.
    else out.set(lc(a), { address: a, classification: 'ORDINARY', state: null, unlockedNow: false })
  })
  if (locks.length === 0) return out

  const FIELDS = 6
  let details: readonly CallResult[]
  try {
    details = await publicClient.multicall({
      allowFailure: true,
      contracts: locks.flatMap((a) => ([
        { address: a, abi: bucketLockAbi, functionName: 'owner' },
        { address: a, abi: bucketLockAbi, functionName: 'token' },
        { address: a, abi: bucketLockAbi, functionName: 'unlockAt' },
        { address: a, abi: bucketLockAbi, functionName: 'target' },
        { address: a, abi: bucketLockAbi, functionName: 'targetMet' },
        { address: USDC, abi: [{
            name: 'balanceOf', type: 'function', stateMutability: 'view',
            inputs: [{ name: 'a', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }],
          }] as const, functionName: 'balanceOf', args: [a] },
      ])) as never,
    })
  } catch {
    for (const a of locks) out.set(lc(a), unavailable(a))
    return out
  }

  const now = BigInt(Math.floor(Date.now() / 1000))

  locks.forEach((a, i) => {
    const slice = details.slice(i * FIELDS, i * FIELDS + FIELDS)

    // Collected with an explicit loop rather than `.some()` + `.map()`: `.some()`
    // does not narrow the union, and a partial read must yield UNAVAILABLE rather
    // than a lock state built from some fields that loaded and some that did not.
    const values: unknown[] = []
    for (const r of slice) {
      if (!r || r.status !== 'success') break
      values.push(r.result)
    }
    if (values.length !== FIELDS) { out.set(lc(a), unavailable(a)); return }

    const [owner, token, unlockAt, target, targetMet, balance] = values

    // Wrong token: the lock is real but does not hold what this product manages.
    if (lc(token as string) !== lc(factory.token)) {
      out.set(lc(a), { address: a, classification: 'UNSUPPORTED', state: null, unlockedNow: false })
      return
    }

    const state: LockState = {
      unlockAt:  unlockAt as bigint,
      target:    target as bigint,
      targetMet: targetMet as boolean,
      balance:   balance as bigint,
    }
    const unlockedNow = isUnlocked(state, now)

    // Provenance is NOT ownership. A genuine lock owned by somebody else must
    // never render as this user's locked bucket: routing deposits there is
    // unrecoverable by the sender.
    if (!user || lc(owner as string) !== lc(user)) {
      out.set(lc(a), { address: a, classification: 'FOREIGN', state, unlockedNow })
      return
    }

    out.set(lc(a), {
      address: a,
      classification: duplicates.has(lc(a)) ? 'CONFLICT' : 'ELIGIBLE',
      state,
      unlockedNow,
    })
  })

  return out
}
