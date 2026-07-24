import 'server-only'
import { isAddress, getAddress, verifyMessage } from 'viem'
import { publicClient } from './arc'
import { getSplitContract, splitAbi } from './contracts'
import { supabase } from './supabase'
import {
  buildAuthMessage,
  decodeAuthHeader,
  PAYROLL_AUTH_HEADER,
  SESSION_TTL_MS,
} from './payroll-session'
import type { PayeeResolution } from './payroll'

// Small clock slack so a token minted just under the TTL isn't rejected for
// millisecond drift between client and server.
const EXPIRY_SLACK_MS = 60_000

/**
 * Verify the stateless payroll session token on a request. Returns the
 * checksummed signer address, or null if missing/expired/invalid. The signer
 * still has to own each resource it touches (checked per-route).
 */
export async function verifyPayrollAuth(req: Request): Promise<`0x${string}` | null> {
  const token = decodeAuthHeader(req.headers.get(PAYROLL_AUTH_HEADER))
  if (!token) return null
  if (!isAddress(token.address)) return null

  const expiresAt = Date.parse(token.expiresAt)
  if (Number.isNaN(expiresAt)) return null
  const now = Date.now()
  // Reject expired tokens and tokens minted with an implausibly long lifetime.
  if (now >= expiresAt) return null
  if (expiresAt > now + SESSION_TTL_MS + EXPIRY_SLACK_MS) return null

  const address = getAddress(token.address)
  try {
    const valid = await verifyMessage({
      address,
      message:   buildAuthMessage(address, token.expiresAt),
      signature: token.signature,
    })
    return valid ? address : null
  } catch {
    return null
  }
}

// ── Ownership ─────────────────────────────────────────────────────────────────

export interface PayrollRow {
  id:               string
  employer_address: string
  name:             string
  created_at:       string
  updated_at:       string
}

/**
 * Load a payroll only if it belongs to `employer`. Returns null when missing or
 * owned by someone else (no existence leak either way).
 */
export async function loadOwnedPayroll(
  id: string,
  employer: `0x${string}`,
): Promise<PayrollRow | null> {
  const { data, error } = await supabase
    .from('payrolls')
    .select('id, employer_address, name, created_at, updated_at')
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return null
  // Defensive: a malformed stored address must return null, not throw.
  if (typeof data.employer_address !== 'string' || !isAddress(data.employer_address)) return null
  if (getAddress(data.employer_address) !== employer) return null
  return data as PayrollRow
}

// ── Roster resolution + bucket pre-validation ────────────────────────────────

export interface RosterInput {
  readonly id:            string
  readonly handle:        string | null
  readonly pinnedAddress: `0x${string}`
}

export interface BucketInfo {
  readonly hasBuckets:   boolean
  readonly bucketsValid: boolean // sums to exactly 10000 bps
  readonly totalBps:     number
  readonly readOk:       boolean // both on-chain reads succeeded
}

export interface ResolveResult {
  readonly resolutions: Map<string, PayeeResolution>
  readonly bucketInfo:  Map<string, BucketInfo> // keyed by checksummed address
}

/**
 * Re-resolve every payee's handle to a current address and pre-validate bucket
 * configs in one Multicall batch. Handle payees resolve via the profiles table;
 * raw-address payees resolve to themselves. isSplitUser (whether the on-chain
 * arg attempts a bucket split) is true only when the config currently sums to
 * 10000 bps - so a broken config becomes a plain transfer rather than relying on
 * the contract's fallback, while a config that breaks between here and execution
 * is still caught by that fallback (the run can never revert).
 */
export async function resolveRoster(payees: readonly RosterInput[]): Promise<ResolveResult> {
  // 1. Batch handle -> address via profiles.
  const handles = [...new Set(
    payees.map((p) => p.handle?.toLowerCase()).filter((h): h is string => !!h),
  )]
  const handleToAddress = new Map<string, `0x${string}`>()
  if (handles.length > 0) {
    const { data } = await supabase
      .from('profiles')
      .select('address, handle')
      .in('handle', handles)
    for (const row of data ?? []) {
      if (typeof row.address === 'string' && typeof row.handle === 'string' && isAddress(row.address)) {
        handleToAddress.set(row.handle.toLowerCase(), getAddress(row.address))
      }
    }
  }

  const resolvedAddressById = new Map<string, `0x${string}` | null>()
  for (const p of payees) {
    if (p.handle) {
      resolvedAddressById.set(p.id, handleToAddress.get(p.handle.toLowerCase()) ?? null)
    } else {
      resolvedAddressById.set(p.id, p.pinnedAddress)
    }
  }

  // 2. Multicall getBuckets + totalBPS for every distinct resolved address.
  const addresses = [...new Set(
    [...resolvedAddressById.values()].filter((a): a is `0x${string}` => a !== null),
  )]
  const bucketInfo = new Map<string, BucketInfo>()

  if (addresses.length > 0) {
    const split = getSplitContract()
    const contracts = addresses.flatMap((addr) => [
      { address: split, abi: splitAbi, functionName: 'getBuckets', args: [addr] } as const,
      { address: split, abi: splitAbi, functionName: 'totalBPS',   args: [addr] } as const,
    ])
    const results = await publicClient.multicall({ contracts, allowFailure: true })

    addresses.forEach((addr, i) => {
      const bucketsRes = results[i * 2]
      const bpsRes     = results[i * 2 + 1]
      const bucketsOk  = bucketsRes?.status === 'success'
      const bpsOk      = bpsRes?.status === 'success'
      // Guard the shapes: viem returns a tuple[] for getBuckets and a bigint for
      // totalBPS, but never trust a cast on a money path.
      const buckets    = bucketsOk && Array.isArray(bucketsRes.result) ? bucketsRes.result : []
      const totalBps   = bpsOk && typeof bpsRes.result === 'bigint' ? Number(bpsRes.result) : 0
      const readOk     = bucketsOk && bpsOk
      bucketInfo.set(addr, {
        hasBuckets:   bucketsOk ? buckets.length > 0 : false,
        bucketsValid: readOk && totalBps === 10_000,
        totalBps,
        readOk,
      })
    })
  }

  // 3. Assemble per-payee resolutions.
  //
  // isSplitUser drives whether the on-chain arg attempts a bucket-splitting
  // depositFor. Attempt it when the payee has buckets OR when we could not read
  // their config (a transient RPC failure must never silently downgrade a real
  // split user to a plain transfer - the contract's try/catch fallback safely
  // covers a config that is actually broken or missing at execution time). Only
  // a definitive empty read routes a plain transfer up front.
  const resolutions = new Map<string, PayeeResolution>()
  for (const p of payees) {
    const resolvedAddress = resolvedAddressById.get(p.id) ?? null
    const info = resolvedAddress ? bucketInfo.get(resolvedAddress) : undefined
    const isSplitUser = info ? (info.hasBuckets || !info.readOk) : false
    resolutions.set(p.id, { id: p.id, resolvedAddress, isSplitUser })
  }

  return { resolutions, bucketInfo }
}
