import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'

// GET /api/stealth/[address] — public lookup of a user's stealth meta-address.
// Meta-addresses are public by design (payers must read them to pay privately).
// Returns { metaAddress: null } when the user has not enabled private payments.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address: raw } = await params
  if (!isAddress(raw)) return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  const address = getAddress(raw)

  const { data, error } = await supabase
    .from('stealth_meta')
    .select('meta_address, scheme_id')
    .eq('address', address)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({
    data: {
      metaAddress: (data?.meta_address as string | undefined) ?? null,
      schemeId:    (data?.scheme_id as number | undefined) ?? null,
    },
  })
}
