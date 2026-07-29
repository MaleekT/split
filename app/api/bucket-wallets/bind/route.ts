import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'

// POST /api/bucket-wallets/bind - attach a reserved derivation index to the bucket
// id that addBucket returned.
//
// Called only after the on-chain create confirms. A reservation that never gets
// bound (tab closed, transaction rejected) is inert: it holds one derivation index
// that allocation then skips, and recoverBucketWalletIndices() still resolves the
// wallet from the chain regardless. The cost of failing here is one wasted index,
// never a mislabelled or unspendable bucket.

const PG_UNIQUE_VIOLATION = '23505'

// Unauthenticated, matching the existing per-bucket metadata routes
// (app/api/bucket-icons/route.ts). Safe because this table is a HINT, never an
// authority: spending re-derives the key and asserts the derived address equals
// the bucket's on-chain destination, so a forged or corrupted row can degrade a
// badge but can never misdirect funds. Residual risk is display-level only.
function isBucketId(v: unknown): v is number {
  // bucket_id is a bigint column. Reject anything past the safe-integer range,
  // where JSON parsing has already lost precision and the value written would not
  // be the value sent.
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const rawAddress = body.address
  const rawWallet  = body.walletAddress
  const bucketId   = body.bucketId

  if (typeof rawAddress !== 'string' || !isAddress(rawAddress)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  if (typeof rawWallet !== 'string' || !isAddress(rawWallet)) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
  }
  if (!isBucketId(bucketId)) {
    return NextResponse.json({ error: 'Invalid bucket id' }, { status: 400 })
  }

  const address = getAddress(rawAddress)
  const wallet  = getAddress(rawWallet)

  // Match on the wallet address rather than the index: the client knows which
  // address it put on-chain for certain, and scoping to this owner's unbound rows
  // means a caller can never bind someone else's reservation or steal a row that
  // is already attached to a different bucket.
  const { data, error } = await supabase
    .from('bucket_wallets')
    .update({ bucket_id: bucketId, bound_at: new Date().toISOString() })
    .eq('address', address)
    .eq('wallet_address', wallet)
    .is('bucket_id', null)
    .select('derivation_index')
    .maybeSingle()

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      return NextResponse.json(
        { error: 'bucket_already_bound', message: 'That bucket already has a generated wallet.' },
        { status: 409 },
      )
    }
    console.error('[bucket-wallets/bind] update failed:', error)
    return NextResponse.json({ error: 'Could not bind the wallet to the bucket' }, { status: 500 })
  }

  if (!data) {
    // No unbound reservation matched. The bucket still works - recovery resolves
    // it from the chain - so this is reported, not treated as fatal.
    return NextResponse.json(
      { error: 'no_reservation', message: 'No unbound reservation found for that wallet address.' },
      { status: 404 },
    )
  }

  return NextResponse.json({ data: { derivationIndex: data.derivation_index, bucketId } })
}
