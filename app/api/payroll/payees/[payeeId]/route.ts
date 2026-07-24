import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'
import { parseUsdcAmount } from '@/lib/payroll'
import { verifyPayrollAuth, loadOwnedPayroll, resolveRoster } from '@/lib/payroll-server'

const LABEL_MAX = 60

interface PayeeRow {
  id:             string
  payroll_id:     string
  handle:         string | null
  pinned_address: string
}

// Load a payee only if its parent payroll belongs to `employer`.
async function loadOwnedPayee(
  payeeId: string,
  employer: `0x${string}`,
): Promise<PayeeRow | null> {
  const { data, error } = await supabase
    .from('payees')
    .select('id, payroll_id, handle, pinned_address')
    .eq('id', payeeId)
    .maybeSingle()
  if (error || !data) return null
  const owned = await loadOwnedPayroll(data.payroll_id as string, employer)
  if (!owned) return null
  return data as PayeeRow
}

// PATCH /api/payroll/payees/[payeeId] - edit label / amount / active, or
// re-confirm a changed address (updates the pinned address, unblocking runs).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ payeeId: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { payeeId } = await params
  const payee = await loadOwnedPayee(payeeId, employer)
  if (!payee) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const { label, amount, active, reconfirmAddress, payPrivate } = body

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (payPrivate !== undefined) {
    if (typeof payPrivate !== 'boolean') return NextResponse.json({ error: 'payPrivate must be a boolean' }, { status: 400 })
    update.pay_private = payPrivate
  }

  if (label !== undefined) {
    if (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > LABEL_MAX) {
      return NextResponse.json({ error: `Label must be 1-${LABEL_MAX} characters` }, { status: 400 })
    }
    update.label = label.trim()
  }

  if (amount !== undefined) {
    if (typeof amount !== 'string') return NextResponse.json({ error: 'Amount must be a string' }, { status: 400 })
    try { update.amount_raw = parseUsdcAmount(amount).toString() }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid amount' }, { status: 400 }) }
  }

  if (active !== undefined) {
    if (typeof active !== 'boolean') return NextResponse.json({ error: 'active must be a boolean' }, { status: 400 })
    update.active = active
  }

  // Explicit re-confirm of a changed address: re-resolve the handle and re-pin.
  if (reconfirmAddress === true) {
    if (!payee.handle) {
      return NextResponse.json({ error: 'This payee has no handle to re-resolve' }, { status: 400 })
    }
    if (!isAddress(payee.pinned_address)) {
      return NextResponse.json({ error: 'Stored address is malformed' }, { status: 500 })
    }
    try {
      const { resolutions } = await resolveRoster([
        { id: payee.id, handle: payee.handle, pinnedAddress: getAddress(payee.pinned_address) },
      ])
      const res = resolutions.get(payee.id)
      if (!res?.resolvedAddress || !isAddress(res.resolvedAddress)) {
        return NextResponse.json({ error: `@${payee.handle} no longer resolves to an address` }, { status: 400 })
      }
      update.pinned_address = res.resolvedAddress
      update.is_split_user  = res.isSplitUser
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to re-resolve handle' },
        { status: 500 },
      )
    }
  }

  const { error } = await supabase.from('payees').update(update).eq('id', payeeId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// DELETE /api/payroll/payees/[payeeId] - remove a payee.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ payeeId: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { payeeId } = await params
  const payee = await loadOwnedPayee(payeeId, employer)
  if (!payee) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabase.from('payees').delete().eq('id', payeeId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
