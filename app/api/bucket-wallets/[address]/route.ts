import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'

interface BucketWalletRow {
  derivation_index: number
  wallet_address:   string
  bucket_id:        number | null
}

// GET /api/bucket-wallets/[address] - which of this user's buckets have an
// app-generated destination.
//
// A HINT for rendering only. It lets badges and the Total Balance breakdown show
// without demanding a signature, since classification is the only part that needs
// one. Nothing here is trusted when money moves: a send re-derives the key and
// asserts the derived address equals the bucket's on-chain destination first.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
): Promise<NextResponse> {
  const { address: raw } = await params
  if (!isAddress(raw)) return NextResponse.json({ error: 'Invalid address' }, { status: 400 })

  const { data, error } = await supabase
    .from('bucket_wallets')
    .select('derivation_index, wallet_address, bucket_id')
    .eq('address', getAddress(raw))
    .not('bucket_id', 'is', null)
    .returns<BucketWalletRow[]>()

  if (error) {
    // Detail stays server-side: raw Postgres errors carry schema internals.
    console.error('[bucket-wallets] lookup failed:', error)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }

  // Serve only well-formed rows, so a corrupted record degrades to "not generated"
  // (which recovery can still resolve from the chain) rather than handing the UI a
  // malformed address.
  const wallets = (data ?? []).flatMap((r) => {
    if (typeof r.wallet_address !== 'string' || !isAddress(r.wallet_address)) return []
    if (!Number.isSafeInteger(r.derivation_index) || r.derivation_index < 0) return []
    if (r.bucket_id === null || !Number.isSafeInteger(r.bucket_id)) return []
    return [{
      bucketId:        r.bucket_id,
      derivationIndex: r.derivation_index,
      walletAddress:   getAddress(r.wallet_address),
    }]
  })

  return NextResponse.json({ data: { wallets } })
}
