import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress, decodeEventLog, pad, numberToHex } from 'viem'
import type { Hex } from 'viem'
import { publicClient } from '@/lib/arc'
import { getSplitContract, splitAbi, ZERO_ADDRESS, MEMO_CONTRACT, memoAbi, type SplitBucket } from '@/lib/contracts'
import { decodeMemoText } from '@/lib/memos'
import { supabase } from '@/lib/supabase'
import { shortAddress } from '@/lib/format'

// Live on-chain activity. The Supabase indexer can't keep up with Arc's ~0.48s blocks
// (it would be days behind), so we read the user's events straight from chain — bounded by
// the contract deploy block and scanned in RPC-safe windows, with an incremental cache.
function getDeployBlock(): bigint {
  const raw = process.env.SPLIT_DEPLOY_BLOCK
  if (!raw || !/^\d+$/.test(raw.trim())) {
    throw new Error('SPLIT_DEPLOY_BLOCK is not set to a valid block number')
  }
  return BigInt(raw.trim())
}

const BLOCK_WINDOW = 9_000n // Arc RPC caps eth_getLogs at a 10k range
const CONCURRENCY  = 12
const MAX_ITEMS    = 50

type RawEvent =
  | { type: 'deposit';   recipient: string; sender: string; amount: bigint; tx: string; logIndex: number; block: bigint }
  | { type: 'split';     bucketId: bigint; share: bigint; destination: string; tx: string; logIndex: number; block: bigint }
  | { type: 'withdraw';  bucketId: bigint; amount: bigint; to: string; tx: string; logIndex: number; block: bigint }
  | { type: 'scheduled'; bucketId: bigint; amount: bigint; destination: string; tx: string; logIndex: number; block: bigint }

type Breakdown = { name: string; amountRaw: string }
type ActivityItem = {
  id: string
  kind: 'deposit' | 'auto_send' | 'scheduled_send' | 'withdraw'
  incoming: boolean
  title: string
  counterparty?: string
  subtitle?: string
  breakdown?: Breakdown[]
  amountRaw: string
  txHash: string
  timestamp: number
  memoText?: string
}

type CacheEntry = { events: RawEvent[]; lastBlock: bigint; blockTimes: Map<string, number>; memoByTx: Map<string, string> }
const cache = new Map<string, CacheEntry>()
const MAX_CACHE_ENTRIES = 500

function setCache(user: string, entry: CacheEntry): void {
  if (!cache.has(user) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(user, entry)
}

// Scan [fromBlock, toBlock] for this contract, decode every log, keep the ones that belong
// to `user`. One pass over all contract logs avoids per-event topic-encoding fiddliness.
async function scanUserEvents(
  contract: `0x${string}`,
  user: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RawEvent[]> {
  // Filter by the indexed user/recipient topic (topic1). Arc's RPC silently drops logs on
  // address-only getLogs, but topic-filtered queries return the full set reliably.
  const userTopic = pad(user.toLowerCase() as `0x${string}`).toLowerCase() as Hex

  const ranges: Array<[bigint, bigint]> = []
  for (let from = fromBlock; from <= toBlock; from += BLOCK_WINDOW) {
    const end = from + BLOCK_WINDOW - 1n
    ranges.push([from, end > toBlock ? toBlock : end])
  }

  const out: RawEvent[] = []
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(([from, to]) =>
        publicClient.request({
          method: 'eth_getLogs',
          params: [{ address: contract, topics: [null, userTopic], fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
        }),
      ),
    )
    for (const logs of results) {
      for (const log of logs) {
        // Confirmed logs always carry these; skip the (pending-only) case rather than coerce.
        if (!log.transactionHash || log.blockNumber == null || log.logIndex == null) continue
        let decoded
        try {
          decoded = decodeEventLog({ abi: splitAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
        } catch { continue }

        const tx       = log.transactionHash
        const logIndex = Number(log.logIndex)
        const block    = BigInt(log.blockNumber)

        switch (decoded.eventName) {
          case 'Deposited': {
            const { recipient, sender, amount } = decoded.args
            if (getAddress(recipient) !== user) break
            out.push({ type: 'deposit', recipient: getAddress(recipient), sender: getAddress(sender), amount, tx, logIndex, block })
            break
          }
          case 'BucketSplit': {
            const { user: u, bucketId, share, destination } = decoded.args
            if (getAddress(u) !== user) break
            out.push({ type: 'split', bucketId, share, destination: getAddress(destination), tx, logIndex, block })
            break
          }
          case 'Withdrawn': {
            const { user: u, bucketId, amount, to } = decoded.args
            if (getAddress(u) !== user) break
            out.push({ type: 'withdraw', bucketId, amount, to: getAddress(to), tx, logIndex, block })
            break
          }
          case 'ScheduledSendExecuted': {
            const { user: u, bucketId, amount, destination } = decoded.args
            if (getAddress(u) !== user) break
            out.push({ type: 'scheduled', bucketId, amount, destination: getAddress(destination), tx, logIndex, block })
            break
          }
          default: break
        }
      }
    }
  }
  return out
}

async function scanMemoEvents(
  fromBlock: bigint,
  toBlock: bigint,
  depositTxHashes: Set<string>,
): Promise<Map<string, string>> {
  if (depositTxHashes.size === 0) return new Map()

  const splitTopic = pad(getSplitContract().toLowerCase() as `0x${string}`).toLowerCase() as Hex

  const ranges: Array<[bigint, bigint]> = []
  for (let from = fromBlock; from <= toBlock; from += BLOCK_WINDOW) {
    const end = from + BLOCK_WINDOW - 1n
    ranges.push([from, end > toBlock ? toBlock : end])
  }

  const memoByTx = new Map<string, string>()
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(([from, to]) =>
        publicClient.request({
          method: 'eth_getLogs',
          params: [{ address: MEMO_CONTRACT, topics: [null, null, splitTopic], fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
        }),
      ),
    )
    for (const logs of results) {
      for (const log of logs) {
        if (!log.transactionHash || !depositTxHashes.has(log.transactionHash)) continue
        try {
          const decoded = decodeEventLog({ abi: memoAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
          if (decoded.eventName !== 'Memo') continue
          const text = decodeMemoText((decoded.args as { memo: `0x${string}` }).memo)
          if (text) memoByTx.set(log.transactionHash, text)
        } catch { /* skip undecodable log */ }
      }
    }
  }
  return memoByTx
}

async function resolveBucketNames(contract: `0x${string}`, user: `0x${string}`): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    const buckets = (await publicClient.readContract({
      address: contract, abi: splitAbi, functionName: 'getBuckets', args: [user],
    })) as readonly SplitBucket[]
    for (const b of buckets) names.set(b.id.toString(), b.name)
  } catch { /* names are best-effort; fall back to "Bucket #id" */ }
  return names
}

async function resolveHandles(senders: string[]): Promise<Map<string, string>> {
  const handles = new Map<string, string>()
  if (senders.length === 0) return handles
  const { data } = await supabase.from('profiles').select('address, handle').in('address', senders)
  for (const row of data ?? []) {
    if (typeof row.address === 'string' && typeof row.handle === 'string') {
      handles.set(getAddress(row.address), row.handle)
    }
  }
  return handles
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address: raw } = await params
  if (!isAddress(raw)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const user = getAddress(raw)

  let deployBlock: bigint
  try {
    deployBlock = getDeployBlock()
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Deploy block misconfigured' }, { status: 500 })
  }

  try {
    const contract = getSplitContract()
    const latest   = await publicClient.getBlockNumber()

    // Incremental scan: reuse cached events, fetch only blocks minted since lastBlock.
    const cached     = cache.get(user)
    const events     = cached ? [...cached.events] : []
    const blockTimes = cached ? new Map(cached.blockTimes) : new Map<string, number>()
    const memoByTx   = cached?.memoByTx ? new Map(cached.memoByTx) : new Map<string, string>()
    const fromBlock  = cached ? cached.lastBlock + 1n : deployBlock

    if (fromBlock <= latest) {
      const newEvents = await scanUserEvents(contract, user, fromBlock, latest)
      events.push(...newEvents)

      // Scan MEMO_CONTRACT for notes attached to new deposit transactions.
      const newDepositTxs = new Set(
        newEvents.filter((e): e is Extract<RawEvent, { type: 'deposit' }> => e.type === 'deposit').map((e) => e.tx),
      )
      const newMemos = await scanMemoEvents(fromBlock, latest, newDepositTxs)
      for (const [tx, text] of newMemos) memoByTx.set(tx, text)

      // Block timestamps (for "2m ago"), fetched once per block and cached.
      const needed = [...new Set(events.map((e) => e.block.toString()))].filter((b) => !blockTimes.has(b))
      if (needed.length > 0) {
        const times = await Promise.all(
          needed.map((b) =>
            publicClient.getBlock({ blockNumber: BigInt(b) })
              .then((blk) => [b, Number(blk.timestamp)] as const)
              .catch(() => [b, 0] as const),
          ),
        )
        for (const [b, t] of times) blockTimes.set(b, t)
      }

      setCache(user, { events, lastBlock: latest, blockTimes, memoByTx })
    }

    // ── Assemble display items ──
    const names = await resolveBucketNames(contract, user)
    const bucketName = (id: bigint) => names.get(id.toString()) ?? `Bucket #${id.toString()}`

    const senders = [...new Set(events.filter((e) => e.type === 'deposit' && e.sender !== e.recipient).map((e) => (e as Extract<RawEvent, { type: 'deposit' }>).sender))]
    const handles = await resolveHandles(senders)

    // Deposit breakdown = all splits sharing the deposit's tx.
    const splitsByTx = new Map<string, Array<Extract<RawEvent, { type: 'split' }>>>()
    for (const e of events) {
      if (e.type === 'split') {
        const arr = splitsByTx.get(e.tx) ?? []
        arr.push(e)
        splitsByTx.set(e.tx, arr)
      }
    }

    // Newest first; within a block, lowest logIndex first so a deposit precedes its sends.
    const ordered = [...events].sort((a, b) => Number(b.block - a.block) || a.logIndex - b.logIndex)

    const items: ActivityItem[] = []
    for (const e of ordered) {
      const ts = blockTimes.get(e.block.toString()) ?? 0
      const id = `${e.tx}-${e.logIndex}`

      if (e.type === 'deposit') {
        const splits = (splitsByTx.get(e.tx) ?? []).slice().sort((a, b) => a.logIndex - b.logIndex)
        const payLink = e.sender !== e.recipient
        const handle = handles.get(e.sender)
        items.push({
          id, kind: 'deposit', incoming: true,
          title: payLink ? 'Payment received via pay link' : 'Direct deposit from your wallet',
          counterparty: payLink ? (handle ? `@${handle}` : shortAddress(e.sender)) : undefined,
          breakdown: splits.map((s) => ({ name: bucketName(s.bucketId), amountRaw: s.share.toString() })),
          amountRaw: e.amount.toString(), txHash: e.tx, timestamp: ts,
          memoText: memoByTx.get(e.tx),
        })
      } else if (e.type === 'split' && e.destination !== ZERO_ADDRESS) {
        items.push({
          id, kind: 'auto_send', incoming: false, title: 'Auto-sent',
          counterparty: `${bucketName(e.bucketId)} → ${shortAddress(e.destination)}`,
          subtitle: 'Triggered by deposit',
          amountRaw: e.share.toString(), txHash: e.tx, timestamp: ts,
        })
      } else if (e.type === 'withdraw') {
        items.push({
          id, kind: 'withdraw', incoming: false, title: 'Withdrew',
          counterparty: `${bucketName(e.bucketId)} → ${shortAddress(e.to)}`,
          amountRaw: e.amount.toString(), txHash: e.tx, timestamp: ts,
        })
      } else if (e.type === 'scheduled') {
        items.push({
          id, kind: 'scheduled_send', incoming: false, title: 'Scheduled send',
          counterparty: `${bucketName(e.bucketId)} → ${shortAddress(e.destination)}`,
          subtitle: 'Recurring transfer',
          amountRaw: e.amount.toString(), txHash: e.tx, timestamp: ts,
        })
      }
    }

    return NextResponse.json({ data: items.slice(0, MAX_ITEMS) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to read activity' }, { status: 500 })
  }
}
