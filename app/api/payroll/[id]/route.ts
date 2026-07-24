import 'server-only'
import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { verifyPayrollAuth, loadOwnedPayroll } from '@/lib/payroll-server'

const NAME_MAX = 60

// GET /api/payroll/[id] - the payroll and its payees.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const payroll = await loadOwnedPayroll(id, employer)
  if (!payroll) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: payees, error } = await supabase
    .from('payees')
    .select('id, label, handle, pinned_address, amount_raw, is_split_user, active, pay_private, created_at')
    .eq('payroll_id', id)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: { payroll, payees: payees ?? [] } })
}

// PATCH /api/payroll/[id] - rename.
export async function PATCH(
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
  const { name } = body
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > NAME_MAX) {
    return NextResponse.json({ error: `Name is required (1-${NAME_MAX} characters)` }, { status: 400 })
  }

  const { error } = await supabase
    .from('payrolls')
    .update({ name: name.trim(), updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// DELETE /api/payroll/[id] - delete the payroll (payees cascade).
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const payroll = await loadOwnedPayroll(id, employer)
  if (!payroll) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabase.from('payrolls').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
