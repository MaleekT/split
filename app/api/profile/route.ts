import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress, verifyMessage } from 'viem'
import { supabase } from '@/lib/supabase'
import { HANDLE_RE } from '@/lib/handle'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const raw = searchParams.get('address')
  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const address = getAddress(raw)
  const { data, error } = await supabase
    .from('profiles')
    .select('handle, avatar_url')
    .eq('address', address)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}

export async function POST(req: Request) {
  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { address: rawAddress, handle, signature } = body as Record<string, unknown>

  if (typeof rawAddress !== 'string' || !isAddress(rawAddress)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle.toLowerCase())) {
    return NextResponse.json({ error: 'Invalid handle' }, { status: 400 })
  }
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  const address         = getAddress(rawAddress)
  const normalizedHandle = handle.toLowerCase()
  const message         = `Split: claim @${normalizedHandle} for ${address.toLowerCase()}`

  const valid = await verifyMessage({
    address,
    message,
    signature: signature as `0x${string}`,
  })
  if (!valid) return NextResponse.json({ error: 'Signature invalid' }, { status: 403 })

  const { error: dbError } = await supabase
    .from('profiles')
    .upsert({ address, handle: normalizedHandle }, { onConflict: 'address' })

  if (dbError) {
    if (dbError.code === '23505') {
      return NextResponse.json({ error: 'Handle already taken' }, { status: 409 })
    }
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, handle: normalizedHandle })
}
