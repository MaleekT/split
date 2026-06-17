import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'

function isNonNegInt(v: unknown): v is string {
  return (typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v))
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const raw = searchParams.get('address')
  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const address = getAddress(raw)
  const { data, error } = await supabase
    .from('bucket_goals')
    .select('bucket_id, target_amount')
    .eq('address', address)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}

export async function POST(req: Request) {
  // Custom-header CSRF check — cross-origin requests cannot set X-Requested-With without a preflight
  if (req.headers.get('X-Requested-With') !== 'XMLHttpRequest') {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { address: rawAddress, bucket_id, target_amount } = body as Record<string, unknown>

  if (typeof rawAddress !== 'string' || !isAddress(rawAddress)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  if (!isNonNegInt(bucket_id)) {
    return NextResponse.json({ error: 'Invalid bucket_id' }, { status: 400 })
  }
  if (!isNonNegInt(target_amount)) {
    return NextResponse.json({ error: 'Invalid target_amount' }, { status: 400 })
  }

  const address         = getAddress(rawAddress)
  const bucketIdStr     = String(bucket_id)
  const targetAmountStr = String(target_amount)

  // "0" means clear — delete the row
  if (targetAmountStr === '0') {
    const { error } = await supabase
      .from('bucket_goals')
      .delete()
      .eq('address', address)
      .eq('bucket_id', bucketIdStr)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, cleared: true })
  }

  const { error } = await supabase
    .from('bucket_goals')
    .upsert(
      { address, bucket_id: bucketIdStr, target_amount: targetAmountStr },
      { onConflict: 'address,bucket_id' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
