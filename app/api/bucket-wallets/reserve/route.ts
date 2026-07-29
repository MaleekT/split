import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'
import { MAX_DERIVATION_INDEX } from '@/lib/bucket-wallet'

// POST /api/bucket-wallets/reserve - claim a derivation index for a new generated
// wallet-bucket, BEFORE the on-chain addBucket call.
//
// Two operations are needed because creation spans two states: the derived
// address must exist to be passed as addBucket's `destination`, but the bucket id
// only exists once addBucket returns. Reserve takes the index; bind attaches it to
// the id afterwards.
//
// The caller supplies the index it derived and the resulting address. The server
// does not derive anything - it cannot, the signature never leaves the client.
// Its only job is to make the claim atomic.

const PG_UNIQUE_VIOLATION = '23505'

// Cap on reservations that were never bound to a bucket. Unauthenticated, like the
// existing per-bucket metadata routes, so without a cap anyone knowing an address
// could spam reservations and push that user's real wallets past the recovery scan
// bound, leaving them shown as `unresolved`. Funds are never at risk (spending
// re-derives and asserts against the on-chain destination), but recovery would be
// degraded. On-chain MAX_BUCKETS is 10, so this is generous for real use while
// bounding abuse.
//
// This cap is deliberately SOFT: the count and the insert below are not atomic, so
// concurrent requests can overshoot it slightly. That is acceptable because it is
// an abuse brake, not a correctness invariant - exceeding it by a few rows harms
// nothing, and each extra row still costs the caller a full request.
//
// The one real invariant here, that two buckets can never be handed the same
// derivation index, is NOT left to this check. It is enforced atomically by the
// unique (address, derivation_index) constraint below. Making this cap atomic too
// would need a trigger or advisory lock: real complexity to harden a limit whose
// failure mode is already harmless.
const MAX_UNBOUND_RESERVATIONS = 20

function isValidIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_DERIVATION_INDEX
}

export async function POST(req: Request): Promise<NextResponse> {
  // Custom-header CSRF check, matching app/api/bucket-icons and /api/goals:
  // cross-origin requests cannot set X-Requested-With without a preflight.
  if (req.headers.get('X-Requested-With') !== 'XMLHttpRequest') {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const rawAddress = body.address
  const rawWallet  = body.walletAddress
  const rawIndex   = body.derivationIndex

  if (typeof rawAddress !== 'string' || !isAddress(rawAddress)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  if (typeof rawWallet !== 'string' || !isAddress(rawWallet)) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
  }
  if (!isValidIndex(rawIndex)) {
    return NextResponse.json({ error: 'Invalid derivation index' }, { status: 400 })
  }

  const address = getAddress(rawAddress)
  const wallet  = getAddress(rawWallet)

  const { count, error: countErr } = await supabase
    .from('bucket_wallets')
    .select('id', { count: 'exact', head: true })
    .eq('address', address)
    .is('bucket_id', null)
  if (countErr) {
    console.error('[bucket-wallets/reserve] count failed:', countErr)
    return NextResponse.json({ error: 'Could not reserve a wallet index' }, { status: 500 })
  }
  if ((count ?? 0) >= MAX_UNBOUND_RESERVATIONS) {
    return NextResponse.json(
      {
        error: 'too_many_reservations',
        message: 'Too many wallet reservations are still unfinished. Finish or discard one before creating another.',
      },
      { status: 429 },
    )
  }

  // Insert, and let the unique (address, derivation_index) constraint decide.
  // On 23505 another tab won this index, so report the conflict and the indices
  // already taken; the client re-derives at the next free one and calls again.
  // A read-then-write check here would race: both callers would see the index
  // free before either wrote.
  const { data, error } = await supabase
    .from('bucket_wallets')
    .insert({ address, derivation_index: rawIndex, wallet_address: wallet })
    .select('id, derivation_index')
    .single()

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      const { data: taken } = await supabase
        .from('bucket_wallets').select('derivation_index').eq('address', address)
      return NextResponse.json(
        {
          error: 'index_taken',
          message: 'That derivation index was just claimed. Derive the next free one and retry.',
          takenIndices: (taken ?? []).map((r) => r.derivation_index as number),
        },
        { status: 409 },
      )
    }
    // Detail stays server-side: raw Postgres errors carry schema internals.
    console.error('[bucket-wallets/reserve] insert failed:', error)
    return NextResponse.json({ error: 'Could not reserve a wallet index' }, { status: 500 })
  }

  return NextResponse.json({
    data: { reservationId: data.id, derivationIndex: data.derivation_index },
  }, { status: 201 })
}

// GET /api/bucket-wallets/reserve?address=0x... - indices already claimed, so the
// client can derive at the first free one instead of guessing and retrying.
export async function GET(req: Request): Promise<NextResponse> {
  const raw = new URL(req.url).searchParams.get('address')
  if (typeof raw !== 'string' || !isAddress(raw)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('bucket_wallets').select('derivation_index').eq('address', getAddress(raw))

  if (error) {
    console.error('[bucket-wallets/reserve] read failed:', error)
    return NextResponse.json({ error: 'Could not read reserved indices' }, { status: 500 })
  }
  return NextResponse.json({
    data: { takenIndices: (data ?? []).map((r) => r.derivation_index as number) },
  })
}
