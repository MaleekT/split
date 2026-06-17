import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'

// Off-chain per-bucket icon metadata. Mirrors /api/goals exactly: keyed by (address, bucket_id),
// read with GET, written with a CSRF-guarded POST. Never touches contract state.

function isNonNegInt(v: unknown): boolean {
  return (typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v))
}

// Bound the stored value so a caller can't write arbitrary data; icon names are short slugs.
function isValidIcon(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const raw = searchParams.get('address')
  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const address = getAddress(raw)
  const { data, error } = await supabase
    .from('bucket_icons')
    .select('bucket_id, icon')
    .eq('address', address)
  if (error) return NextResponse.json({ error: 'Database error' }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}

export async function POST(req: Request) {
  // Custom-header CSRF check — cross-origin requests cannot set X-Requested-With without a preflight.
  if (req.headers.get('X-Requested-With') !== 'XMLHttpRequest') {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { address: rawAddress, bucket_id, icon } = body as Record<string, unknown>

  if (typeof rawAddress !== 'string' || !isAddress(rawAddress)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  if (!isNonNegInt(bucket_id)) {
    return NextResponse.json({ error: 'Invalid bucket_id' }, { status: 400 })
  }
  if (!isValidIcon(icon)) {
    return NextResponse.json({ error: 'Invalid icon' }, { status: 400 })
  }

  const address     = getAddress(rawAddress)
  const bucketIdStr = String(bucket_id)

  const { error } = await supabase
    .from('bucket_icons')
    .upsert(
      { address, bucket_id: bucketIdStr, icon },
      { onConflict: 'address,bucket_id' },
    )
  if (error) return NextResponse.json({ error: 'Database error' }, { status: 500 })
  return NextResponse.json({ success: true })
}
