import 'server-only'
import { NextResponse } from 'next/server'
import { getAddress } from 'viem'
import { supabase } from '@/lib/supabase'
import { verifyPayrollAuth } from '@/lib/payroll-server'

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const RUN_STATUSES = ['executing', 'completed', 'partial', 'failed'] as const

interface RunRow {
  id:               string
  employer_address: string
}

// Load a run only if it belongs to `employer`.
async function loadOwnedRun(
  runId: string,
  employer: `0x${string}`,
): Promise<RunRow | null> {
  const { data, error } = await supabase
    .from('payroll_runs')
    .select('id, employer_address')
    .eq('id', runId)
    .maybeSingle()
  if (error || !data) return null
  if (typeof data.employer_address !== 'string') return null
  try {
    if (getAddress(data.employer_address) !== employer) return null
  } catch { return null }
  return data as RunRow
}

// GET /api/payroll/runs/[runId] - run detail with items (history + resume).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { runId } = await params
  const run = await loadOwnedRun(runId, employer)
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: runFull }, { data: items, error }] = await Promise.all([
    supabase.from('payroll_runs')
      .select('id, base_run_id, status, total_raw, payee_count, chunk_count, chunks_confirmed, created_at, updated_at')
      .eq('id', runId).single(),
    supabase.from('payroll_run_items')
      .select('chunk_index, item_index, chunk_run_id, payee_dest, label, amount_raw, is_split_user, mode, memo_hash, outcome, tx_hash')
      .eq('run_ref', runId)
      .order('chunk_index', { ascending: true })
      .order('item_index', { ascending: true }),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: { run: runFull, items: items ?? [] } })
}

// PATCH /api/payroll/runs/[runId] - record a chunk's submitted tx hash, and/or
// update the run status. The indexer independently reconciles per-payee outcomes
// from chain events; this records client-side execution progress for resume.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { runId } = await params
  const run = await loadOwnedRun(runId, employer)
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const { chunkIndex, txHash, status } = body

  // Record a chunk's tx hash across its items.
  if (chunkIndex !== undefined || txHash !== undefined) {
    if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return NextResponse.json({ error: 'chunkIndex must be a non-negative integer' }, { status: 400 })
    }
    if (typeof txHash !== 'string' || !TX_HASH_RE.test(txHash)) {
      return NextResponse.json({ error: 'txHash must be a 0x transaction hash' }, { status: 400 })
    }
    const { error } = await supabase
      .from('payroll_run_items')
      .update({ tx_hash: txHash })
      .eq('run_ref', runId)
      .eq('chunk_index', chunkIndex)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Update run status (client marks completed/partial/failed after execution).
  if (status !== undefined) {
    if (typeof status !== 'string' || !RUN_STATUSES.includes(status as (typeof RUN_STATUSES)[number])) {
      return NextResponse.json({ error: `status must be one of ${RUN_STATUSES.join(', ')}` }, { status: 400 })
    }
    const { error } = await supabase
      .from('payroll_runs')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', runId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
