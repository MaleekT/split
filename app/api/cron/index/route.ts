import 'server-only'
import { NextResponse } from 'next/server'
import { decodeEventLog, getAddress } from 'viem'
import type { Hex, Log } from 'viem'
import { publicClient } from '@/lib/arc'
import { getSplitContract, splitAbi } from '@/lib/contracts'
import { supabase } from '@/lib/supabase'

// Arc produces ~0.48 s blocks; 1 000 blocks ≈ 8 min — safe for a 2-min cron.
const MAX_BLOCKS_PER_RUN = 1_000
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ── Types ─────────────────────────────────────────────────────────────────────

type EventType = 'deposit' | 'split' | 'withdraw' | 'scheduled_send'

type ActivityRow = {
  user_address:   string
  event_type:     EventType
  tx_hash:        string
  log_index:      number
  bucket_id:      number | null
  bucket_name:    null
  // Stored as number — safe for testnet (see safeNum() guard below).
  amount_raw:     number
  sender_address: string | null
  destination:    string | null
  block_number:   number
}

type ScheduledSendRow = {
  user_address:     string
  bucket_id:        number
  amount_raw:       number
  interval_seconds: number
  // nextSendAt is uint64 Unix seconds from Solidity's `block.timestamp + interval`
  next_send_at:     string
  destination:      string
  active:           boolean
}

type ScheduleFetch = { user: `0x${string}`; bucketId: bigint }

type ClassifiedLogs = {
  activityRows:    ActivityRow[]
  scheduleFetches: ScheduleFetch[]
  schedCancels:    Array<{ user_address: string; bucket_id: number }>
  decodeErrors:    number
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// Do NOT bypass on NODE_ENV — Vercel preview branches may not set it to 'production'.
// Set SKIP_CRON_AUTH=true explicitly in .env.local for local dev only.

function authorized(req: Request): boolean {
  if (process.env.SKIP_CRON_AUTH === 'true') return true
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 1. Read cursor
  const { data: stateRow, error: stateReadErr } = await supabase
    .from('indexer_state')
    .select('last_block')
    .eq('key', 'split')
    .single()

  if (stateReadErr) {
    return NextResponse.json(
      { error: `cursor read: ${stateReadErr.message}` },
      { status: 500 },
    )
  }

  const lastBlock    = (stateRow?.last_block as number | null) ?? 0
  const currentBlock = safeNum(await publicClient.getBlockNumber(), 'getBlockNumber')

  if (lastBlock >= currentBlock) {
    return NextResponse.json({ ok: true, indexed: 0, message: 'up to date' })
  }

  const fromBlock = lastBlock + 1
  const toBlock   = Math.min(currentBlock, fromBlock + MAX_BLOCKS_PER_RUN - 1)

  // 2. Fetch all logs from the Split contract in this range
  const contractAddress = getSplitContract()
  const logs = await publicClient.getLogs({
    address:   contractAddress,
    fromBlock: BigInt(fromBlock),
    toBlock:   BigInt(toBlock),
  })

  // 3. Decode all logs synchronously — no network calls here
  const { activityRows, scheduleFetches, schedCancels, decodeErrors } = classifyLogs(logs)

  // 4. Fetch all scheduled-send state in parallel (one RPC call per schedule event)
  const schedResults = await Promise.all(
    scheduleFetches.map(({ user, bucketId }) =>
      fetchScheduledSend(contractAddress, user, bucketId),
    ),
  )
  const schedUpserts = schedResults.filter((r): r is ScheduledSendRow => r !== null)

  // 5. Persist — all writes use idempotent upserts so a failed mid-run is safe to retry.
  //    The cursor only advances (step 6) when every write has returned without error.
  //    On retry, the unique constraints (tx_hash+log_index, user_address+bucket_id) ensure
  //    already-written rows are skipped cleanly.

  if (activityRows.length > 0) {
    const { error } = await supabase
      .from('activity')
      .upsert(activityRows, { onConflict: 'tx_hash,log_index', ignoreDuplicates: true })
    if (error) {
      return NextResponse.json({ error: `activity upsert: ${error.message}` }, { status: 500 })
    }
  }

  if (schedUpserts.length > 0) {
    const { error } = await supabase
      .from('scheduled_sends_index')
      .upsert(schedUpserts, { onConflict: 'user_address,bucket_id' })
    if (error) {
      return NextResponse.json({ error: `sched upsert: ${error.message}` }, { status: 500 })
    }
  }

  // Single parameterized RPC — avoids filter-string construction and stays one round-trip.
  // See migration: bulk_cancel_scheduled_sends (restricted to service_role via GRANT).
  if (schedCancels.length > 0) {
    const { error } = await supabase.rpc('bulk_cancel_scheduled_sends', {
      p_pairs: schedCancels,
    })
    if (error) {
      return NextResponse.json({ error: `sched cancel: ${error.message}` }, { status: 500 })
    }
  }

  // 6. Advance cursor — only reached if all writes above returned without error
  const { error: stateWriteErr } = await supabase
    .from('indexer_state')
    .upsert({ key: 'split', last_block: toBlock }, { onConflict: 'key' })
  if (stateWriteErr) {
    return NextResponse.json(
      { error: `cursor write: ${stateWriteErr.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok:           true,
    from:         fromBlock,
    to:           toBlock,
    logs:         logs.length,
    activity:     activityRows.length,
    schedUpserts: schedUpserts.length,
    schedCancels: schedCancels.length,
    decodeErrors,
  })
}

// ── Synchronous log classifier ────────────────────────────────────────────────

function classifyLogs(logs: Log[]): ClassifiedLogs {
  const activityRows:    ActivityRow[]   = []
  const scheduleFetches: ScheduleFetch[] = []
  const schedCancels:    Array<{ user_address: string; bucket_id: number }> = []
  let   decodeErrors = 0

  for (const log of logs) {
    const txHash      = log.transactionHash ?? ''
    const logIndex    = log.logIndex        ?? 0
    const blockNumber = safeNum(log.blockNumber ?? BigInt(0), 'log.blockNumber')

    let decoded
    try {
      decoded = decodeEventLog({
        abi:    splitAbi,
        data:   log.data,
        topics: log.topics as [Hex, ...Hex[]],
      })
    } catch {
      decodeErrors++
      continue
    }

    switch (decoded.eventName) {
      case 'Deposited': {
        const { recipient, sender, amount } = decoded.args
        activityRows.push({
          user_address:   getAddress(recipient),
          event_type:     'deposit',
          tx_hash:        txHash,
          log_index:      logIndex,
          bucket_id:      null,
          bucket_name:    null,
          amount_raw:     safeNum(amount, 'Deposited.amount'),
          sender_address: getAddress(sender),
          destination:    null,
          block_number:   blockNumber,
        })
        break
      }

      case 'BucketSplit': {
        const { user, bucketId, share, destination } = decoded.args
        activityRows.push({
          user_address:   getAddress(user),
          event_type:     'split',
          tx_hash:        txHash,
          log_index:      logIndex,
          bucket_id:      safeNum(bucketId, 'BucketSplit.bucketId'),
          bucket_name:    null,
          amount_raw:     safeNum(share, 'BucketSplit.share'),
          sender_address: null,
          destination:    destination === ZERO_ADDRESS ? null : getAddress(destination),
          block_number:   blockNumber,
        })
        break
      }

      case 'Withdrawn': {
        const { user, bucketId, amount, to } = decoded.args
        activityRows.push({
          user_address:   getAddress(user),
          event_type:     'withdraw',
          tx_hash:        txHash,
          log_index:      logIndex,
          bucket_id:      safeNum(bucketId, 'Withdrawn.bucketId'),
          bucket_name:    null,
          amount_raw:     safeNum(amount, 'Withdrawn.amount'),
          sender_address: null,
          destination:    getAddress(to),
          block_number:   blockNumber,
        })
        break
      }

      case 'ScheduledSendExecuted': {
        const { user, bucketId, amount, destination } = decoded.args
        activityRows.push({
          user_address:   getAddress(user),
          event_type:     'scheduled_send',
          tx_hash:        txHash,
          log_index:      logIndex,
          bucket_id:      safeNum(bucketId, 'ScheduledSendExecuted.bucketId'),
          bucket_name:    null,
          amount_raw:     safeNum(amount, 'ScheduledSendExecuted.amount'),
          sender_address: null,
          destination:    getAddress(destination),
          block_number:   blockNumber,
        })
        // Timer was advanced inside the contract — fetch fresh next_send_at below
        scheduleFetches.push({ user: getAddress(user) as `0x${string}`, bucketId })
        break
      }

      case 'ScheduledSendSet': {
        const { user, bucketId } = decoded.args
        // Normalize address consistently with all other cases
        scheduleFetches.push({ user: getAddress(user) as `0x${string}`, bucketId })
        break
      }

      case 'ScheduledSendCancelled': {
        const { user, bucketId } = decoded.args
        schedCancels.push({
          user_address: getAddress(user),
          bucket_id:    safeNum(bucketId, 'ScheduledSendCancelled.bucketId'),
        })
        break
      }

      // BucketAdded / BucketUpdated / BucketDeleted:
      // bucket config is canonical on-chain — no Supabase writes needed.
      default:
        break
    }
  }

  return { activityRows, scheduleFetches, schedCancels, decodeErrors }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchScheduledSend(
  contractAddress: `0x${string}`,
  user:            `0x${string}`,
  bucketId:        bigint,
): Promise<ScheduledSendRow | null> {
  try {
    const s = await publicClient.readContract({
      address:      contractAddress,
      abi:          splitAbi,
      functionName: 'getScheduledSend',
      args:         [user, bucketId],
    })
    // readContract throws on revert; defensive guard for future viem type changes
    if (!s || !s.active) return null
    return {
      user_address:     getAddress(user),
      bucket_id:        safeNum(bucketId, 'getScheduledSend.bucketId'),
      amount_raw:       safeNum(s.amount, 'getScheduledSend.amount'),
      interval_seconds: safeNum(s.interval, 'getScheduledSend.interval'),
      // s.nextSendAt is uint64 Unix seconds (Solidity: block.timestamp + interval)
      next_send_at:     new Date(safeNum(s.nextSendAt, 'getScheduledSend.nextSendAt') * 1000).toISOString(),
      destination:      getAddress(s.destination),
      active:           true,
    }
  } catch {
    // Bucket deleted or RPC failure — leave the index row unchanged.
    return null
  }
}

// Converts bigint to number with an explicit overflow guard.
// Safe for all values on Arc Testnet — amounts, bucket IDs, block numbers, and
// intervals are all far below Number.MAX_SAFE_INTEGER (9 × 10^15).
// Throws loudly rather than silently losing precision if a value somehow exceeds the limit.
function safeNum(n: bigint, label: string): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label}: ${n} exceeds Number.MAX_SAFE_INTEGER — cannot convert safely`)
  }
  return Number(n)
}
