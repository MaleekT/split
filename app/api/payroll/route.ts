import 'server-only'
import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { verifyPayrollAuth } from '@/lib/payroll-server'

const NAME_MAX = 60

// GET /api/payroll - list the authenticated employer's payrolls.
export async function GET(req: Request): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('payrolls')
    .select('id, name, created_at, updated_at')
    .eq('employer_address', employer)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}

// POST /api/payroll - create a payroll roster.
export async function POST(req: Request): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

  const { data, error } = await supabase
    .from('payrolls')
    .insert({ employer_address: employer, name: name.trim() })
    .select('id, name, created_at, updated_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data }, { status: 201 })
}
