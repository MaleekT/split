import 'server-only'
import { NextResponse } from 'next/server'
import { decodeEventLog } from 'viem'
import type { Hex, Log } from 'viem'
import { publicClient } from '@/lib/arc'
import { getSplitPayrollV2Contract, splitPayrollV2Abi } from '@/lib/payroll-contracts'
import { supabase } from '@/lib/supabase'

// Arc produces ~0.48s blocks; 1000 blocks ≈ 8 min - safe for a 2-min cron.
const MAX_BLOCKS_PER_RUN = 1_000
const CURSOR_KEY = 'payroll'

// ── Auth (same contract as the existing crons) ──────────────────────────────
function authorized(req: Request): boolean {
  if (process.env.SKIP_CRON_AUTH === 'true') return true
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

function safeNum(n: bigint, label: string): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label}: ${n} exceeds Number.MAX_SAFE_INTEGER`)
  }
  return Number(n)
}

// A single runPayroll tx's SplitPayroll-filtered logs: one PayrollRun (its runId)
// plus the per-payee PayrollPayment events in payee-array (item_index) order.
interface ChunkRecon {
  runId:    string
  txHash:   string
  payments: Array<{ itemIndex: number; outcome: number }>
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // If SplitPayroll isn't deployed/configured yet, no-op cleanly (not an error).
  let contractAddress: `0x${string}`
  try { contractAddress = getSplitPayrollV2Contract() }
  catch { return NextResponse.json({ ok: true, indexed: 0, message: 'payroll contract not configured' }) }

  // 1. Cursor. On a fresh cursor (0), start from the deploy block if provided,
  //    else from the current head - never scan from genesis.
  const { data: stateRow, error: stateReadErr } = await supabase
    .from('indexer_state').select('last_block').eq('key', CURSOR_KEY).maybeSingle()
  if (stateReadErr) return NextResponse.json({ error: `cursor read: ${stateReadErr.message}` }, { status: 500 })

  const currentBlock = safeNum(await publicClient.getBlockNumber(), 'getBlockNumber')
  const deployBlock  = Number(process.env.PAYROLL_DEPLOY_BLOCK ?? 0)
  const storedLast   = (stateRow?.last_block as number | null) ?? 0
  const lastBlock    = storedLast > 0
    ? storedLast
    : (deployBlock > 0 ? deployBlock - 1 : currentBlock - 1)

  if (lastBlock >= currentBlock) {
    return NextResponse.json({ ok: true, indexed: 0, message: 'up to date' })
  }
  const fromBlock = lastBlock + 1
  const toBlock   = Math.min(currentBlock, fromBlock + MAX_BLOCKS_PER_RUN - 1)

  // 2. Fetch + decode SplitPayroll logs; group into per-chunk reconciliations.
  const logs = await publicClient.getLogs({
    address: contractAddress, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock),
  })
  const byTx = groupByTx(logs)

  let itemsUpdated = 0
  const updatedChunkRunIds = new Set<string>()

  for (const recon of byTx) {
    if (!recon.runId) continue
    for (const p of recon.payments) {
      const { error } = await supabase
        .from('payroll_run_items')
        .update({ outcome: p.outcome, tx_hash: recon.txHash })
        .eq('chunk_run_id', recon.runId)
        .eq('item_index', p.itemIndex)
      if (error) return NextResponse.json({ error: `item update: ${error.message}` }, { status: 500 })
      itemsUpdated++
    }
    updatedChunkRunIds.add(recon.runId)
  }

  // 3. Reconcile run status for every run whose chunks were touched.
  let runsCompleted = 0
  if (updatedChunkRunIds.size > 0) {
    const { data: refRows } = await supabase
      .from('payroll_run_items').select('run_ref').in('chunk_run_id', [...updatedChunkRunIds])
    const runRefs = new Set((refRows ?? []).map((r) => r.run_ref as string))
    for (const runRef of runRefs) {
      if (await reconcileRun(runRef)) runsCompleted++
    }
  }

  // 4. Advance cursor only after all writes succeeded.
  const { error: writeErr } = await supabase
    .from('indexer_state').upsert({ key: CURSOR_KEY, last_block: toBlock }, { onConflict: 'key' })
  if (writeErr) return NextResponse.json({ error: `cursor write: ${writeErr.message}` }, { status: 500 })

  return NextResponse.json({
    ok: true, from: fromBlock, to: toBlock, logs: logs.length, itemsUpdated, runsCompleted,
  })
}

// Group SplitPayroll logs by transaction into per-chunk reconciliations.
function groupByTx(logs: Log[]): ChunkRecon[] {
  const map = new Map<string, ChunkRecon>()
  for (const log of logs) {
    const txHash = log.transactionHash ?? ''
    if (!txHash) continue
    let decoded
    try {
      decoded = decodeEventLog({ abi: splitPayrollV2Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
    } catch { continue }

    let entry = map.get(txHash)
    if (!entry) { entry = { runId: '', txHash, payments: [] }; map.set(txHash, entry) }

    if (decoded.eventName === 'PayrollRun') {
      entry.runId = (decoded.args as { runId: bigint }).runId.toString()
    } else if (decoded.eventName === 'PayrollPayment') {
      // PayrollPayment events are emitted in payee-array order, so their ordinal
      // within this tx equals the item_index recorded at run creation.
      const outcome = Number((decoded.args as { outcome: number }).outcome)
      entry.payments.push({ itemIndex: entry.payments.length, outcome })
    }
  }
  return [...map.values()]
}

// Recompute a run's confirmed-chunk count and mark it completed when every chunk
// has fully reconciled. Returns true if it transitioned to completed.
async function reconcileRun(runRef: string): Promise<boolean> {
  const { data: run } = await supabase
    .from('payroll_runs').select('id, chunk_count, status').eq('id', runRef).maybeSingle()
  if (!run) return false

  const { data: items } = await supabase
    .from('payroll_run_items').select('chunk_index, outcome').eq('run_ref', runRef)
  if (!items) return false

  const chunkItems = new Map<number, { total: number; done: number }>()
  for (const it of items) {
    const ci = it.chunk_index as number
    const agg = chunkItems.get(ci) ?? { total: 0, done: 0 }
    agg.total++
    if (it.outcome !== null && it.outcome !== undefined) agg.done++
    chunkItems.set(ci, agg)
  }
  let confirmed = 0
  for (const agg of chunkItems.values()) if (agg.total > 0 && agg.done === agg.total) confirmed++

  const isComplete = confirmed === (run.chunk_count as number)
  const nextStatus = isComplete ? 'completed' : (run.status as string)
  await supabase
    .from('payroll_runs')
    .update({ chunks_confirmed: confirmed, status: nextStatus, updated_at: new Date().toISOString() })
    .eq('id', runRef)

  return isComplete && run.status !== 'completed'
}
