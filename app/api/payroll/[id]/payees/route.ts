import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'
import { isValidHandle } from '@/lib/handle'
import { parseUsdcAmount } from '@/lib/payroll'
import { verifyPayrollAuth, loadOwnedPayroll, resolveRoster } from '@/lib/payroll-server'

const LABEL_MAX = 60

/**
 * Resolve a "recipient" (either a raw 0x address or a Split handle) into a
 * pinned address + optional handle. Handle lookups go through the profiles table.
 */
async function resolveRecipient(
  recipient: string,
): Promise<{ handle: string | null; pinnedAddress: `0x${string}` } | { error: string }> {
  if (isAddress(recipient)) {
    return { handle: null, pinnedAddress: getAddress(recipient) }
  }
  const handle = recipient.trim().toLowerCase().replace(/^@/, '')
  if (!isValidHandle(handle)) return { error: 'Enter a valid Split handle or 0x address' }

  const { data, error } = await supabase
    .from('profiles')
    .select('address, handle')
    .eq('handle', handle)
    .maybeSingle()
  if (error) return { error: `Handle lookup failed: ${error.message}` }
  if (!data || typeof data.address !== 'string' || !isAddress(data.address)) {
    return { error: `No Split account found for @${handle}` }
  }
  return { handle, pinnedAddress: getAddress(data.address) }
}

// POST /api/payroll/[id]/payees - add a payee (resolves + pins the address).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const employer = await verifyPayrollAuth(req)
  if (!employer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const payroll = await loadOwnedPayroll(id, employer)
  if (!payroll) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const { label, recipient, amount } = body

  if (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > LABEL_MAX) {
    return NextResponse.json({ error: `Label is required (1-${LABEL_MAX} characters)` }, { status: 400 })
  }
  if (typeof recipient !== 'string' || recipient.trim().length === 0) {
    return NextResponse.json({ error: 'Recipient is required' }, { status: 400 })
  }
  if (typeof amount !== 'string') {
    return NextResponse.json({ error: 'Amount is required' }, { status: 400 })
  }

  let amountRaw: bigint
  try { amountRaw = parseUsdcAmount(amount) }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid amount' }, { status: 400 }) }

  const resolved = await resolveRecipient(recipient)
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: 400 })

  try {
    // Pre-validate the resolved address's bucket config for the on-chain routing flag.
    const { resolutions, bucketInfo } = await resolveRoster([
      { id: 'new', handle: resolved.handle, pinnedAddress: resolved.pinnedAddress },
    ])
    const isSplitUser = resolutions.get('new')?.isSplitUser ?? false
    const info = bucketInfo.get(resolved.pinnedAddress)

    const { data, error } = await supabase
      .from('payees')
      .insert({
        payroll_id:     id,
        label:          label.trim(),
        handle:         resolved.handle,
        pinned_address: resolved.pinnedAddress,
        amount_raw:     amountRaw.toString(),
        is_split_user:  isSplitUser,
      })
      .select('id, label, handle, pinned_address, amount_raw, is_split_user, active, created_at')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({
      data,
      bucketInfo: info ? { hasBuckets: info.hasBuckets, bucketsValid: info.bucketsValid } : null,
    }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to add payee' },
      { status: 500 },
    )
  }
}
