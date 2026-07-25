import 'server-only'
import { decodeEventLog, getAddress } from 'viem'
import type { Hex, Log } from 'viem'
import { publicClient } from '@/lib/arc'
import { getAnnouncerContract, announcerAbi } from '@/lib/stealth-contracts'
import { supabase } from '@/lib/supabase'

// Shared ERC-5564 announcement indexing, used by both the cron and the on-demand
// sync the recipient's scan triggers.
//
// Two hard constraints shape this:
//   1. Arc's RPC rejects any getLogs span wider than 100k blocks, so every query
//      must be chunked.
//   2. Arc produces ~166k blocks/day (~0.52s per block). A run that advanced a
//      fixed 1k blocks could never catch up - it would fall ~165k blocks further
//      behind every day. So a run loops chunks until it reaches head or exhausts
//      its budget, and the next run resumes from the persisted cursor.
//
// The Announcer emits very few events, so cost is driven by the number of RPC
// round-trips (one per chunk), not by the block span covered.

export const CHUNK_SPAN = 99_000
const MAX_CHUNKS_PER_RUN = 60
const TIME_BUDGET_MS = 20_000
const CURSOR_KEY = 'stealth'
// Sentinel meaning "never indexed"; the run then starts from STEALTH_DEPLOY_BLOCK.
const INITIAL_CURSOR = 0

export interface CatchUpResult {
  ok:           boolean
  from:         number | null
  to:           number | null
  chunks:       number
  indexed:      number
  decodeErrors: number
  caughtUp:     boolean
  message?:     string
}

interface AnnouncementRow {
  scheme_id:         number
  stealth_address:   string
  caller:            string
  ephemeral_pub_key: string
  metadata:          string
  block_number:      number
  tx_hash:           string
  log_index:         number
}

function safeNum(n: bigint, label: string): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label}: ${n} exceeds MAX_SAFE_INTEGER`)
  return Number(n)
}

export function decodeAnnouncements(logs: Log[]): { rows: AnnouncementRow[]; decodeErrors: number } {
  const out: AnnouncementRow[] = []
  let decodeErrors = 0
  for (const log of logs) {
    if (!log.transactionHash) continue
    let decoded
    try {
      decoded = decodeEventLog({ abi: announcerAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
    } catch { decodeErrors++; continue }
    if (decoded.eventName !== 'Announcement') continue
    const args = decoded.args as {
      schemeId: bigint; stealthAddress: `0x${string}`; caller: `0x${string}`
      ephemeralPubKey: `0x${string}`; metadata: `0x${string}`
    }
    out.push({
      scheme_id:         safeNum(args.schemeId, 'schemeId'),
      stealth_address:   getAddress(args.stealthAddress),
      caller:            getAddress(args.caller),
      ephemeral_pub_key: args.ephemeralPubKey,
      metadata:          args.metadata,
      block_number:      safeNum(log.blockNumber ?? 0n, 'blockNumber'),
      tx_hash:           log.transactionHash,
      log_index:         log.logIndex ?? 0,
    })
  }
  return { rows: out, decodeErrors }
}

// Single-flight guard: concurrent scans must not each replay the same chunks.
// Late callers await the run already in progress instead of duplicating its work.
let inFlight: Promise<CatchUpResult> | null = null

export function catchUpAnnouncements(): Promise<CatchUpResult> {
  if (inFlight) return inFlight
  const run = runCatchUp().finally(() => { inFlight = null })
  inFlight = run
  return run
}

async function runCatchUp(): Promise<CatchUpResult> {
  const empty = (message: string, caughtUp: boolean): CatchUpResult => ({
    ok: true, from: null, to: null, chunks: 0, indexed: 0, decodeErrors: 0, caughtUp, message,
  })

  // No-op cleanly until the Announcer is deployed/configured.
  let announcer: `0x${string}`
  try { announcer = getAnnouncerContract() }
  catch { return empty('announcer not configured', false) }

  const { data: stateRow, error: stateErr } = await supabase
    .from('indexer_state').select('last_block').eq('key', CURSOR_KEY).maybeSingle()
  if (stateErr) throw new Error(`cursor read: ${stateErr.message}`)

  // Guarantee the cursor row exists so the monotonic conditional updates below
  // always match a row (a no-op update would strand the cursor and re-scan forever).
  // The seeded value and the fallback below are the same constant, so the two can
  // never drift apart.
  if (!stateRow) {
    const { error } = await supabase
      .from('indexer_state').upsert({ key: CURSOR_KEY, last_block: INITIAL_CURSOR }, { onConflict: 'key' })
    if (error) throw new Error(`cursor init: ${error.message}`)
  }

  const currentBlock = safeNum(await publicClient.getBlockNumber(), 'getBlockNumber')
  const deployBlock  = Number(process.env.STEALTH_DEPLOY_BLOCK ?? 0)
  const storedLast   = (stateRow?.last_block as number | null) ?? INITIAL_CURSOR
  const lastBlock    = storedLast > 0 ? storedLast : (deployBlock > 0 ? deployBlock - 1 : currentBlock - 1)

  if (lastBlock >= currentBlock) return empty('up to date', true)

  const startedAt = Date.now()
  const firstFrom = lastBlock + 1
  let cursor       = lastBlock
  let chunks       = 0
  let indexed      = 0
  let decodeErrors = 0

  while (cursor < currentBlock && chunks < MAX_CHUNKS_PER_RUN) {
    const fromBlock = cursor + 1
    const toBlock   = Math.min(currentBlock, fromBlock + CHUNK_SPAN - 1)

    const logs = await publicClient.getLogs({
      address: announcer, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock),
    })
    const decoded = decodeAnnouncements(logs)
    decodeErrors += decoded.decodeErrors

    if (decoded.rows.length > 0) {
      const { error } = await supabase
        .from('announcements')
        .upsert(decoded.rows, { onConflict: 'tx_hash,log_index', ignoreDuplicates: true })
      // Stop before advancing the cursor: advancing past un-persisted rows would
      // permanently skip those announcements, silently hiding real payments.
      if (error) throw new Error(`announcements upsert: ${error.message}`)
      indexed += decoded.rows.length
    }

    cursor = toBlock
    chunks++

    // Persist progress after every chunk so an interrupted run never replays work.
    // The `lt` filter makes this an atomic forward-only write: if another instance
    // already advanced further, this update matches no row and is skipped, so a
    // slower run can never drag the cursor back and force needless re-scans.
    const { error: writeErr } = await supabase
      .from('indexer_state')
      .update({ last_block: cursor })
      .eq('key', CURSOR_KEY)
      .lt('last_block', cursor)
    if (writeErr) throw new Error(`cursor write: ${writeErr.message}`)

    if (Date.now() - startedAt > TIME_BUDGET_MS) break
  }

  // Progress fields describe THIS run, not global index state. If a concurrent
  // instance advanced the cursor further, the forward-only write above is skipped
  // and these under-report - which is the safe direction: rows were still
  // persisted, and under-reporting at worst causes a redundant (idempotent) run.
  return {
    ok: true,
    from: firstFrom,
    to: cursor,
    chunks,
    indexed,
    decodeErrors,
    caughtUp: cursor >= currentBlock,
  }
}
