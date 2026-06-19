import 'server-only'
import { NextResponse } from 'next/server'
import { createWalletClient, http, getAddress, encodeFunctionData, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from '@/lib/chain'
import { publicClient } from '@/lib/arc'
import { getSplitContract, splitAbi, MEMO_CONTRACT, memoAbi } from '@/lib/contracts'
import { supabase } from '@/lib/supabase'

// Arc produces ~0.48 s blocks; 5 sends × ~1.5 s each ≈ 7.5 s — within Vercel's 10 s limit.
const BATCH_LIMIT   = 5
const TX_TIMEOUT_MS = 5_000 // per-tx confirmation cap; Arc finalizes in <1 s normally
const RUN_BUDGET_MS = 8_000 // stops the loop before Vercel's 10 s hard limit

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

  const schedulerKey = process.env.SCHEDULER_PRIVATE_KEY
  if (!schedulerKey) {
    return NextResponse.json({ error: 'SCHEDULER_PRIVATE_KEY not configured' }, { status: 500 })
  }

  const rpcUrl = process.env.NEXT_PUBLIC_ARC_RPC
  if (!rpcUrl) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_ARC_RPC not configured' }, { status: 500 })
  }
  try {
    new URL(rpcUrl)
  } catch (urlErr) {
    return NextResponse.json(
      { error: `NEXT_PUBLIC_ARC_RPC is not a valid URL: ${urlErr instanceof Error ? urlErr.message : String(urlErr)}` },
      { status: 500 },
    )
  }

  const account = privateKeyToAccount(schedulerKey as `0x${string}`)
  const walletClient = createWalletClient({
    account,
    chain:     arcTestnet,
    transport: http(rpcUrl),
  })

  const contractAddress = getSplitContract()

  // 1. Query active sends that are due — oldest first so partial batches are fair
  const { data: dueSends, error: queryError } = await supabase
    .from('scheduled_sends_index')
    .select('user_address, bucket_id, interval_seconds')
    .eq('active', true)
    .lte('next_send_at', new Date().toISOString())
    .order('next_send_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (queryError) {
    return NextResponse.json({ error: `query: ${queryError.message}` }, { status: 500 })
  }

  if (!dueSends || dueSends.length === 0) {
    return NextResponse.json({ ok: true, executed: 0, skipped: 0, errors: 0, message: 'nothing due' })
  }

  let executed = 0
  let skipped  = 0
  let errors   = 0
  const failReasons: string[] = []

  const runStart = Date.now()

  // 2. Execute sequentially — parallel sends from the same wallet require explicit nonce
  //    management; sequential auto-nonce is correct and safe within this batch size.
  for (const row of dueSends) {
    // Stop before hitting Vercel's 10 s function limit
    if (Date.now() - runStart > RUN_BUDGET_MS) break

    // Validate row shape — Supabase bigint columns arrive as number or string
    const rawAddress  = row.user_address
    const rawBucketId = row.bucket_id
    const rawInterval = row.interval_seconds

    if (typeof rawAddress !== 'string' || rawBucketId == null || rawInterval == null) {
      errors++
      failReasons.push('malformed row from scheduled_sends_index')
      continue
    }

    const user        = getAddress(rawAddress) as `0x${string}`
    const bucketIdNum = Number(rawBucketId)
    if (!Number.isInteger(bucketIdNum) || bucketIdNum < 0) {
      errors++
      failReasons.push(`non-integer bucket_id: ${String(rawBucketId)}`)
      continue
    }
    const bucketId = BigInt(bucketIdNum)

    try {
      // writeContract simulates via eth_call before broadcasting; TooEarly or BucketNotFound
      // reverts here (no gas spent) if contract state changed since the Supabase query.
      const innerData = encodeFunctionData({
        abi:          splitAbi,
        functionName: 'executeScheduledSend',
        args:         [user, bucketId],
      })
      const memoNote = `Scheduled send — bucket ${bucketIdNum} — ${new Date().toISOString().slice(0, 10)}`
      const hash = await walletClient.writeContract({
        address:      MEMO_CONTRACT,
        abi:          memoAbi,
        functionName: 'memo',
        args:         [
          contractAddress,
          innerData,
          keccak256(toHex(`scheduled-${bucketIdNum}-${Date.now()}`)),
          toHex(memoNote),
        ],
      })

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: 500,        // matches Arc's ~0.48 s block time
        timeout:         TX_TIMEOUT_MS,
      })

      if (receipt.status === 'success') {
        // Optimistic update prevents the next hourly run from re-queuing this send.
        // The event indexer (cron/index) corrects the exact value via getScheduledSend
        // within 2 minutes — this estimate uses Date.now() instead of block.timestamp.
        await supabase
          .from('scheduled_sends_index')
          .update({
            next_send_at: new Date(Date.now() + Number(rawInterval) * 1000).toISOString(),
          })
          .eq('user_address', rawAddress)
          .eq('bucket_id', bucketIdNum)
        executed++
      } else {
        // Tx included but reverted — viem's pre-flight simulation makes this rare.
        // Happens if state changed between simulation and block inclusion.
        skipped++
      }
    } catch (err) {
      // TooEarly: Supabase next_send_at stale (contract is the authoritative guard).
      // BucketNotFound: bucket deleted since last index run.
      // WaitForTransactionReceiptTimeoutError: RPC slow or Arc disruption.
      errors++
      failReasons.push(err instanceof Error ? err.message : String(err))
    }
  }

  return NextResponse.json({
    ok:      true,
    executed,
    skipped,
    errors,
    total:   dueSends.length,
    ...(failReasons.length > 0 && { failReasons }),
  })
}
