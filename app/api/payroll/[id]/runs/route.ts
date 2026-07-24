import 'server-only'
import { NextResponse } from 'next/server'
import { getAddress } from 'viem'
import { supabase } from '@/lib/supabase'
import { USDC } from '@/lib/contracts'
import { getSplitPayrollV2Contract, PAYROLL_MODE } from '@/lib/payroll-contracts'
import { verifyPayrollAuth, loadOwnedPayroll, resolveRoster } from '@/lib/payroll-server'
import {
  buildRunDiff,
  hasBlockingChanges,
  requiresConfirmation,
  runTotalRaw,
  computeMemoHash,
  chunk,
  makeBaseRunId,
  chunkRunId,
  CHUNK_SIZE,
  type RosterPayee,
  type PreviousRunItem,
} from '@/lib/payroll'

interface PayeeDbRow {
  id: string
  label: string
  handle: string | null
  pinned_address: string
  amount_raw: string | number
  is_split_user: boolean
  active: boolean
  pay_private: boolean
}

interface ExecPayee {
  dest:        `0x${string}`         // resolved real address (the employer's record)
  amountRaw:   bigint
  mode:        number                // PAYROLL_MODE: 0 split / 1 plain / 2 private
  memoHash:    `0x${string}`
  label:       string
  metaAddress: `0x${string}` | null  // published stealth meta-address, for mode 2
}

function toRosterPayee(row: PayeeDbRow): RosterPayee {
  return {
    id:            row.id,
    label:         row.label,
    handle:        row.handle,
    pinnedAddress: getAddress(row.pinned_address),
    amountRaw:     String(row.amount_raw),
    isSplitUser:   row.is_split_user,
    active:        row.active,
  }
}

async function loadPreviousByAddress(payrollId: string): Promise<Map<string, PreviousRunItem>> {
  const map = new Map<string, PreviousRunItem>()
  const { data: run } = await supabase
    .from('payroll_runs').select('id')
    .eq('payroll_id', payrollId).eq('status', 'completed')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!run) return map
  const { data: items } = await supabase
    .from('payroll_run_items').select('payee_dest, amount_raw, label').eq('run_ref', run.id)
  for (const it of items ?? []) {
    const dest = getAddress(it.payee_dest as string)
    map.set(dest, { payeeDest: dest, amountRaw: String(it.amount_raw), label: (it.label as string | null) ?? null })
  }
  return map
}

// GET /api/payroll/[id]/runs - run history for a payroll.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const payroll = await loadOwnedPayroll(id, employer)
  if (!payroll) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('payroll_runs')
    .select('id, base_run_id, status, total_raw, payee_count, chunk_count, chunks_confirmed, created_at')
    .eq('payroll_id', id)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}

// POST /api/payroll/[id]/runs - create a run.
// Server is the source of truth for destinations: it re-resolves, enforces the
// diff gate (hard-block on address change, require acknowledge for soft changes),
// snapshots the run + items BEFORE any funds move, and returns the chunk plan for
// the employer's wallet to execute. The server never holds or moves funds.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const payroll = await loadOwnedPayroll(id, employer)
  if (!payroll) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const acknowledge = body.acknowledge === true

  try {
    // Guard against double-pay: if an executing OR partial run exists, it must be
    // resumed (finish only its unsent chunks) or cancelled before a fresh run can
    // start. A fresh run over a partial one would re-pay chunks that already landed.
    const { data: inProgress } = await supabase
      .from('payroll_runs').select('id, status')
      .eq('payroll_id', id).in('status', ['executing', 'partial'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (inProgress) {
      return NextResponse.json(
        { error: 'resumable', message: 'An unfinished run exists. Resume or cancel it first.',
          runRef: inProgress.id, runStatus: inProgress.status },
        { status: 409 },
      )
    }

    const { data: rows, error: rErr } = await supabase
      .from('payees')
      .select('id, label, handle, pinned_address, amount_raw, is_split_user, active, pay_private')
      .eq('payroll_id', id).eq('active', true)
      .order('created_at', { ascending: true })
    if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 })

    const dbRows = (rows ?? []) as PayeeDbRow[]
    const payees = dbRows.map((r) => toRosterPayee(r))
    if (payees.length === 0) return NextResponse.json({ error: 'No active payees to run' }, { status: 400 })
    const payPrivateById = new Map(dbRows.map((r) => [r.id, r.pay_private === true]))

    // ── Enforce the pre-send verification gate server-side ────────────────────
    const { resolutions } = await resolveRoster(payees)
    const previousByAddress = await loadPreviousByAddress(id)
    const diff = buildRunDiff(payees, resolutions, previousByAddress)

    if (hasBlockingChanges(diff)) {
      return NextResponse.json(
        { error: 'blocking_changes', message: 'Some payees changed address or no longer resolve. Re-confirm them before running.',
          entries: diff.filter((d) => d.blocking) },
        { status: 409 },
      )
    }
    if (requiresConfirmation(diff) && !acknowledge) {
      return NextResponse.json(
        { error: 'confirmation_required', message: 'New or changed payees need confirmation before running.',
          entries: diff.filter((d) => d.requiresConfirmation) },
        { status: 409 },
      )
    }

    // Batch-lookup published meta-addresses for payees that opted into private pay.
    const privateAddrs = payees
      .filter((p) => payPrivateById.get(p.id))
      .map((p) => resolutions.get(p.id)?.resolvedAddress)
      .filter((a): a is `0x${string}` => !!a)
    const metaByAddress = new Map<string, `0x${string}`>()
    if (privateAddrs.length > 0) {
      const { data: metas } = await supabase
        .from('stealth_meta').select('address, meta_address').in('address', privateAddrs)
      for (const m of metas ?? []) {
        if (typeof m.address === 'string' && typeof m.meta_address === 'string') {
          metaByAddress.set(getAddress(m.address), m.meta_address as `0x${string}`)
        }
      }
    }

    // ── Build the authoritative execution snapshot from server resolution ─────
    const execPayees: ExecPayee[] = payees.map((p) => {
      const res = resolutions.get(p.id)
      // Non-null asserted by the no-blocking check above (unresolved is blocking).
      const dest = res!.resolvedAddress as `0x${string}`
      const meta = metaByAddress.get(dest) ?? null
      // Private only when the payee opted in AND has a published meta-address;
      // otherwise fall back to normal split/plain routing.
      const wantsPrivate = payPrivateById.get(p.id) === true && meta !== null
      const mode = wantsPrivate
        ? PAYROLL_MODE.PRIVATE
        : (res!.isSplitUser ? PAYROLL_MODE.SPLIT : PAYROLL_MODE.PLAIN)
      return {
        dest,
        amountRaw:   BigInt(p.amountRaw),
        mode,
        memoHash:    computeMemoHash(p.label),
        label:       p.label,
        metaAddress: wantsPrivate ? meta : null,
      }
    })

    const totalRaw   = runTotalRaw(execPayees.map((e) => e.amountRaw))
    const baseRunId  = makeBaseRunId()
    const chunks     = chunk(execPayees, CHUNK_SIZE)
    const splitPayroll = getSplitPayrollV2Contract()

    // Persist the run and every item BEFORE returning the plan to execute.
    const { data: run, error: runErr } = await supabase
      .from('payroll_runs')
      .insert({
        payroll_id:       id,
        employer_address: employer,
        base_run_id:      baseRunId,
        status:           'executing',
        total_raw:        totalRaw.toString(),
        payee_count:      execPayees.length,
        chunk_count:      chunks.length,
      })
      .select('id').single()
    if (runErr || !run) return NextResponse.json({ error: runErr?.message ?? 'Failed to create run' }, { status: 500 })

    const itemRows = chunks.flatMap((items, chunkIndex) =>
      items.map((it, itemIndex) => ({
        run_ref:       run.id,
        chunk_index:   chunkIndex,
        item_index:    itemIndex,
        chunk_run_id:  chunkRunId(baseRunId, chunkIndex),
        payee_dest:    it.dest, // the real contractor address (employer's private record)
        label:         it.label,
        amount_raw:    it.amountRaw.toString(),
        is_split_user: it.mode === PAYROLL_MODE.SPLIT,
        mode:          it.mode,
        memo_hash:     it.memoHash,
      })),
    )
    const { error: itemsErr } = await supabase.from('payroll_run_items').insert(itemRows)
    if (itemsErr) {
      // Roll back the run row so a failed item insert doesn't strand a run.
      await supabase.from('payroll_runs').delete().eq('id', run.id)
      return NextResponse.json({ error: itemsErr.message }, { status: 500 })
    }

    // The plan the employer's wallet executes: approve `totalRaw` to splitPayroll,
    // then one runPayroll (V2) tx per chunk. For private payees the client computes
    // the one-time stealth address from `metaAddress` at execution; the server
    // never computes stealth addresses (no client crypto on the server).
    const plan = chunks.map((items, chunkIndex) => ({
      chunkIndex,
      runId:    chunkRunId(baseRunId, chunkIndex),
      totalRaw: runTotalRaw(items.map((i) => i.amountRaw)).toString(),
      payees:   items.map((i) => ({
        dest:        i.dest,
        amount:      i.amountRaw.toString(),
        mode:        i.mode,
        memoHash:    i.memoHash,
        metaAddress: i.metaAddress,
      })),
    }))

    return NextResponse.json({
      data: {
        runRef:       run.id,
        baseRunId,
        splitPayroll,
        usdc:         USDC,
        totalRaw:     totalRaw.toString(),
        chunkCount:   chunks.length,
        chunks:       plan,
      },
    }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create run' },
      { status: 500 },
    )
  }
}
