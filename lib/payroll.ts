import { parseUnits, keccak256, toHex, zeroHash } from 'viem'
import type { PayrollPayeeArg } from './payroll-contracts'

// ── Constants ───────────────────────────────────────────────────────────────

export const USDC_DECIMALS = 6

// Payees per on-chain runPayroll transaction. Well under the contract's
// MAX_PAYEES = 100 cap (a 100-payee run is ~40-45% of Arc's 30M block limit per
// the Phase 1 benchmark); 50 keeps each chunk comfortably cheap with margin.
export const CHUNK_SIZE = 50

// Sane upper bound on a single logical run, so the UI and DB can't be handed an
// unbounded list. Chunked into CHUNK_SIZE transactions.
export const MAX_PAYEES_PER_RUN = 1_000

export const MAX_MEMO_LENGTH = 200

// uint128 max - every per-payee amount must fit the contract's uint128 field.
const UINT128_MAX = (1n << 128n) - 1n

// ── Domain types ──────────────────────────────────────────────────────────────

export interface RosterPayee {
  readonly id:            string
  readonly label:         string
  readonly handle:        string | null
  readonly pinnedAddress: `0x${string}`
  readonly amountRaw:     string   // bigint as decimal string (DB bigint)
  readonly isSplitUser:   boolean
  readonly active:        boolean
}

// Result of re-resolving one payee's handle + bucket config at run time.
export interface PayeeResolution {
  readonly id:              string
  readonly resolvedAddress: `0x${string}` | null // null = handle no longer resolves
  readonly isSplitUser:     boolean               // whether the on-chain arg attempts a bucket split
}

// Snapshot of a payee as executed in a previous run (for run-to-run diffing).
export interface PreviousRunItem {
  readonly payeeDest: `0x${string}`
  readonly amountRaw: string
  readonly label:     string | null
}

export type PayeeChangeKind =
  | 'unchanged'
  | 'new'
  | 'amount_changed'
  | 'address_changed'
  | 'unresolved'

export interface PayeeDiffEntry {
  readonly payeeId:              string
  readonly label:                string
  readonly kind:                 PayeeChangeKind
  readonly pinnedAddress:        `0x${string}`
  readonly resolvedAddress:      `0x${string}` | null
  readonly currentAmountRaw:     string
  readonly previousAmountRaw:    string | null
  readonly requiresConfirmation: boolean // soft: new / amount_changed
  readonly blocking:             boolean // hard: address_changed / unresolved
}

export interface ChunkPlan {
  readonly chunkIndex: number
  readonly runId:      string          // on-chain runId (numeric string) for this chunk
  readonly items:      readonly PayrollPayeeArg[]
}

// ── Amount parsing ────────────────────────────────────────────────────────────

/**
 * Parse a user-entered USDC amount string into 6-decimal raw units.
 * Throws on empty, non-numeric, non-positive, over-precise, or over-uint128 input.
 */
export function parseUsdcAmount(input: string): bigint {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Amount is required')
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount: "${input}"`)

  const decimals = trimmed.split('.')[1]?.length ?? 0
  if (decimals > USDC_DECIMALS) {
    throw new Error(`Amount has more than ${USDC_DECIMALS} decimal places: "${input}"`)
  }

  const raw = parseUnits(trimmed, USDC_DECIMALS)
  if (raw <= 0n)            throw new Error('Amount must be greater than zero')
  if (raw > UINT128_MAX)    throw new Error('Amount exceeds the maximum supported value')
  return raw
}

/** Sum of raw amounts. Pure bigint arithmetic. */
export function runTotalRaw(amountsRaw: readonly bigint[]): bigint {
  return amountsRaw.reduce((acc, a) => acc + a, 0n)
}

// ── Memo hashing ──────────────────────────────────────────────────────────────

/**
 * Per-payee reference hash echoed in the PayrollPayment event. Empty note maps
 * to the zero hash (no memo). Deterministic keccak256 of the trimmed text.
 */
export function computeMemoHash(note: string): `0x${string}` {
  const trimmed = note.trim().slice(0, MAX_MEMO_LENGTH)
  if (!trimmed) return zeroHash
  return keccak256(toHex(trimmed))
}

// ── Chunking ──────────────────────────────────────────────────────────────────

/** Split an array into fixed-size chunks. The last chunk may be shorter. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

// ── Run-id derivation ─────────────────────────────────────────────────────────

/**
 * Numeric base for a logical run's chunk runIds. Millisecond timestamp keeps it
 * unique per run and comfortably within Number.MAX_SAFE_INTEGER before scaling.
 */
export function makeBaseRunId(now: number = Date.now()): string {
  return String(now)
}

/**
 * On-chain runId for one chunk, derived from the run base and chunk index.
 * base * 1000 + chunkIndex - unique per chunk within a run and across runs.
 * Returned as a decimal string; pass BigInt(...) to the contract's uint256 arg.
 */
export function chunkRunId(baseRunId: string, chunkIndex: number): string {
  if (!/^\d+$/.test(baseRunId)) throw new Error(`Invalid baseRunId: "${baseRunId}"`)
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= 1000) {
    throw new Error(`chunkIndex out of range: ${chunkIndex}`)
  }
  return (BigInt(baseRunId) * 1000n + BigInt(chunkIndex)).toString()
}

// ── On-chain arg construction ─────────────────────────────────────────────────

/**
 * Build the on-chain Payee tuple for one resolved payee. The resolved address
 * (not the pinned address) is used as the destination, so callers MUST have
 * already reconciled the two via the diff gate (a mismatch is blocking).
 */
export function toPayrollArg(
  resolvedAddress: `0x${string}`,
  amountRaw: bigint,
  isSplitUser: boolean,
  memoHash: `0x${string}`,
): PayrollPayeeArg {
  return { dest: resolvedAddress, amount: amountRaw, isSplitUser, memoHash }
}

/** Plan the chunked on-chain calls for a run. */
export function planChunks(
  args: readonly PayrollPayeeArg[],
  baseRunId: string,
  size: number = CHUNK_SIZE,
): ChunkPlan[] {
  return chunk(args, size).map((items, chunkIndex) => ({
    chunkIndex,
    runId: chunkRunId(baseRunId, chunkIndex),
    items,
  }))
}

// ── Pre-send verification (the diff-and-confirm gate) ─────────────────────────

/**
 * Classify one payee by comparing its re-resolution and its previous-run
 * snapshot. Security-critical: a handle that now resolves to a different
 * address than the pinned one (or no longer resolves) is BLOCKING and must be
 * explicitly re-confirmed by a human before any funds move (Bottleneck 8).
 */
export function diffPayee(
  payee: RosterPayee,
  resolution: PayeeResolution,
  previous: PreviousRunItem | undefined,
): PayeeDiffEntry {
  const base = {
    payeeId:          payee.id,
    label:            payee.label,
    pinnedAddress:    payee.pinnedAddress,
    resolvedAddress:  resolution.resolvedAddress,
    currentAmountRaw: payee.amountRaw,
    previousAmountRaw: previous?.amountRaw ?? null,
  }

  // Hard block: the handle no longer resolves at all.
  if (resolution.resolvedAddress === null) {
    return { ...base, kind: 'unresolved', requiresConfirmation: false, blocking: true }
  }

  // Hard block: the handle now points somewhere other than the pinned address.
  if (resolution.resolvedAddress !== payee.pinnedAddress) {
    return { ...base, kind: 'address_changed', requiresConfirmation: false, blocking: true }
  }

  // Soft confirm: payee not present in the last run.
  if (previous === undefined) {
    return { ...base, kind: 'new', requiresConfirmation: true, blocking: false }
  }

  // Soft confirm: amount changed since the last run.
  if (previous.amountRaw !== payee.amountRaw) {
    return { ...base, kind: 'amount_changed', requiresConfirmation: true, blocking: false }
  }

  return { ...base, kind: 'unchanged', requiresConfirmation: false, blocking: false }
}

/**
 * Build the full diff for a run. `previousByAddress` maps a pinned address to
 * that payee's last-run snapshot (keyed by address, since that is what actually
 * received funds last time).
 */
export function buildRunDiff(
  payees: readonly RosterPayee[],
  resolutionsById: ReadonlyMap<string, PayeeResolution>,
  previousByAddress: ReadonlyMap<string, PreviousRunItem>,
): PayeeDiffEntry[] {
  return payees.map((p) => {
    const resolution = resolutionsById.get(p.id) ?? {
      id: p.id, resolvedAddress: null, isSplitUser: false,
    }
    return diffPayee(p, resolution, previousByAddress.get(p.pinnedAddress))
  })
}

/** True if any entry is a hard block (address changed or unresolved). */
export function hasBlockingChanges(diff: readonly PayeeDiffEntry[]): boolean {
  return diff.some((d) => d.blocking)
}

/** True if any entry needs a soft confirmation (new or amount changed). */
export function requiresConfirmation(diff: readonly PayeeDiffEntry[]): boolean {
  return diff.some((d) => d.requiresConfirmation)
}
