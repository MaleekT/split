import 'server-only'
import { NextResponse } from 'next/server'
import { getAddress } from 'viem'
import { supabase } from '@/lib/supabase'
import { verifyPayrollAuth, loadOwnedPayroll, resolveRoster } from '@/lib/payroll-server'
import {
  buildRunDiff,
  hasBlockingChanges,
  requiresConfirmation,
  runTotalRaw,
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

// Load the most recent completed run's items as the "known-good last time" set,
// keyed by the address that actually received funds.
async function loadPreviousByAddress(payrollId: string): Promise<Map<string, PreviousRunItem>> {
  const map = new Map<string, PreviousRunItem>()
  const { data: run } = await supabase
    .from('payroll_runs')
    .select('id')
    .eq('payroll_id', payrollId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!run) return map

  const { data: items } = await supabase
    .from('payroll_run_items')
    .select('payee_dest, amount_raw, label')
    .eq('run_ref', run.id)
  for (const it of items ?? []) {
    const dest = getAddress(it.payee_dest as string)
    map.set(dest, { payeeDest: dest, amountRaw: String(it.amount_raw), label: (it.label as string | null) ?? null })
  }
  return map
}

// POST /api/payroll/[id]/resolve - re-resolve + pre-validate + diff the active
// roster against the last run. Read-only preview that powers the confirm gate.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const payroll = await loadOwnedPayroll(id, employer)
  if (!payroll) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: rows, error } = await supabase
    .from('payees')
    .select('id, label, handle, pinned_address, amount_raw, is_split_user, active')
    .eq('payroll_id', id)
    .eq('active', true)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const payees = (rows ?? []).map((r) => toRosterPayee(r as PayeeDbRow))
  if (payees.length === 0) {
    return NextResponse.json({ error: 'No active payees to run' }, { status: 400 })
  }

  try {
    const { resolutions, bucketInfo } = await resolveRoster(payees)
    const previousByAddress = await loadPreviousByAddress(id)
    const diff = buildRunDiff(payees, resolutions, previousByAddress)

    const entries = diff.map((d) => {
      const res  = resolutions.get(d.payeeId)
      const info = res?.resolvedAddress ? bucketInfo.get(res.resolvedAddress) : undefined
      return {
        ...d,
        isSplitUser:  res?.isSplitUser ?? false,
        hasBuckets:   info?.hasBuckets ?? false,
        bucketsValid: info?.bucketsValid ?? false,
        readOk:       info?.readOk ?? false,
      }
    })

    const total = runTotalRaw(payees.map((p) => BigInt(p.amountRaw)))
    return NextResponse.json({
      data: {
        entries,
        summary: {
          totalRaw:             total.toString(),
          payeeCount:           payees.length,
          chunkCount:           Math.ceil(payees.length / CHUNK_SIZE),
          hasBlocking:          hasBlockingChanges(diff),
          requiresConfirmation: requiresConfirmation(diff),
        },
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to resolve roster' },
      { status: 500 },
    )
  }
}
