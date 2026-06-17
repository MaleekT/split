import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { publicClient } from '@/lib/arc'
import { getSplitContract, splitAbi } from '@/lib/contracts'

// Bounds the on-chain scan. Set in .env.local (SPLIT_DEPLOY_BLOCK). Never default to 0:
// Arc mints ~0.48s blocks, so a genesis-to-head scan would be millions of blocks per request.
function getDeployBlock(): bigint {
  const raw = process.env.SPLIT_DEPLOY_BLOCK
  if (!raw || !/^\d+$/.test(raw.trim())) {
    throw new Error('SPLIT_DEPLOY_BLOCK is not set to a valid block number')
  }
  return BigInt(raw.trim())
}

// Arc's RPC caps eth_getLogs at a 10,000-block range — stay safely under it.
const BLOCK_WINDOW = 9_000n
// How many window queries to run at once. Bounded to avoid RPC rate-limiting.
const CONCURRENCY = 12

// Incremental per-instance cache: the first request for a user does the full deploy→head
// scan (seconds); every later request scans only the handful of blocks minted since, so
// polling stays cheap. Lost on serverless cold-starts (re-scans once) — acceptable per the
// live-on-chain design; the durable path at scale is the Supabase event indexer.
type CacheEntry = { totals: Map<string, bigint>; lastBlock: bigint }
const cache = new Map<string, CacheEntry>()
// Cap distinct cached addresses so the map can't grow unbounded under many users.
const MAX_CACHE_ENTRIES = 500

function setCache(user: string, entry: CacheEntry): void {
  // Map preserves insertion order — evict the oldest entry once over the cap.
  if (!cache.has(user) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(user, entry)
}

// Sum BucketSplit.share per bucketId across [fromBlock, toBlock], scanned in RPC-safe
// windows run in bounded-concurrency batches. The indexed `user` topic keeps results tiny.
async function scanRange(
  contractAddress: `0x${string}`,
  user: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  totals: Map<string, bigint>,
): Promise<void> {
  const ranges: Array<[bigint, bigint]> = []
  for (let from = fromBlock; from <= toBlock; from += BLOCK_WINDOW) {
    const end = from + BLOCK_WINDOW - 1n
    ranges.push([from, end > toBlock ? toBlock : end])
  }

  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(([from, to]) =>
        publicClient.getContractEvents({
          address:   contractAddress,
          abi:       splitAbi,
          eventName: 'BucketSplit',
          args:      { user },
          fromBlock: from,
          toBlock:   to,
        }),
      ),
    )
    for (const logs of results) {
      for (const log of logs) {
        const { bucketId, share } = log.args
        if (bucketId === undefined || share === undefined) continue
        const key = bucketId.toString()
        totals.set(key, (totals.get(key) ?? 0n) + share)
      }
    }
  }
}

// Cumulative USDC the contract has routed to each bucket's destination wallet.
// A bucket whose destination later changed sums all historical shares under its bucketId;
// ids reused via swap-and-pop deletes are rare on testnet. Hold buckets also appear here,
// but the UI ignores their value (it shows the in-contract balance instead).
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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Deploy block misconfigured' },
      { status: 500 },
    )
  }

  try {
    const contractAddress = getSplitContract()
    const latest = await publicClient.getBlockNumber()

    // Resume from the cache if present, scanning only newly-minted blocks; otherwise
    // start a fresh full scan from the deploy block.
    const cached = cache.get(user)
    const totals = cached ? new Map(cached.totals) : new Map<string, bigint>()
    const fromBlock = cached ? cached.lastBlock + 1n : deployBlock

    if (fromBlock <= latest) {
      await scanRange(contractAddress, user, fromBlock, latest, totals)
      setCache(user, { totals, lastBlock: latest })
    }

    const data: Record<string, string> = {}
    for (const [key, value] of totals) data[key] = value.toString()

    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read routed totals' },
      { status: 500 },
    )
  }
}
