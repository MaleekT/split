import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress, verifyMessage } from 'viem'
import { supabase } from '@/lib/supabase'
import { buildStealthRegisterMessage, META_ADDRESS_RE, STEALTH_SCHEME_ID } from '@/lib/stealth-contracts'

// POST /api/stealth/register — store the caller's stealth meta-address off-chain.
// Authenticated by a wallet signature that must recover to `address` (the same
// per-action signature pattern as /api/profile). The on-chain ERC-6538 Registry
// write is done separately by the client's wallet in the setup flow.
export async function POST(req: Request): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const { address: rawAddress, metaAddress, signature } = body
  if (typeof rawAddress !== 'string' || !isAddress(rawAddress)) {
    return NextResponse.json({ error: 'Valid address required' }, { status: 400 })
  }
  // ERC-5564 scheme-1 meta-address: 0x + two secp256k1 pubkeys. Compressed is
  // 132 hex chars; allow up to uncompressed to be tolerant of SDK encoding.
  if (typeof metaAddress !== 'string' || !META_ADDRESS_RE.test(metaAddress)) {
    return NextResponse.json({ error: 'Valid meta-address required' }, { status: 400 })
  }
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  const address = getAddress(rawAddress)
  let valid = false
  try {
    valid = await verifyMessage({
      address,
      message:   buildStealthRegisterMessage(address, metaAddress),
      signature: signature as `0x${string}`,
    })
  } catch {
    valid = false
  }
  if (!valid) return NextResponse.json({ error: 'Signature does not match address' }, { status: 401 })

  const { error } = await supabase
    .from('stealth_meta')
    .upsert({
      address,
      meta_address: metaAddress,
      scheme_id:    Number(STEALTH_SCHEME_ID),
      updated_at:   new Date().toISOString(),
    }, { onConflict: 'address' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
