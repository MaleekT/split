import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'
import { META_ADDRESS_RE } from '@/lib/stealth-contracts'
import { isLinkToken } from '@/lib/stealth-link'

interface StealthMetaRow {
  meta_address: string | null
  scheme_id:    number | null
  link_token:   string | null
}

// GET /api/stealth/[address] - public lookup of a user's stealth meta-address.
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
    .select('meta_address, scheme_id, link_token')
    .eq('address', address)
    .maybeSingle<StealthMetaRow>()

  if (error) {
    // Detail stays server-side: raw Postgres errors carry schema internals.
    console.error('[stealth/address] lookup failed:', error)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }

  // Serve each field only when it is well-formed, so a corrupted row degrades to
  // "privacy not enabled" instead of handing a payer a malformed meta-address
  // (which feeds stealth-address derivation) or a broken link.
  const meta  = data?.meta_address
  const token = data?.link_token
  const metaAddress = typeof meta === 'string'  && META_ADDRESS_RE.test(meta) ? meta  : null
  const linkToken   = typeof token === 'string' && isLinkToken(token)         ? token : null

  return NextResponse.json({
    data: {
      metaAddress,
      schemeId: typeof data?.scheme_id === 'number' ? data.scheme_id : null,
      // Returned unauthenticated so the owner's Privacy page can show their link
      // without a wallet signature. This is deliberate but not free: the token
      // confers no capability the meta-address above does not already confer
      // (both only let someone PAY this user privately, and the meta-address is
      // the actual crypto material), BUT it does mean rotating a token is not a
      // revocation mechanism against anyone who knows this address and can
      // simply re-read the new one. Rotation only sheds casual reuse of an old
      // link. Gate this behind ownership proof before treating it as a secret.
      linkToken,
    },
  })
}
