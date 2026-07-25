import 'server-only'
import { NextResponse } from 'next/server'
import { catchUpAnnouncements, type CatchUpResult } from '@/lib/stealth-index'

export const maxDuration = 30

// POST /api/stealth/sync - bring the announcement index up to chain head before
// a recipient scans. Detection must not depend on the daily cron: Vercel does not
// run crons on preview deployments, and a recipient should never wait up to a day
// to see a payment that already landed.
//
// Unauthenticated by design: this indexes PUBLIC chain data into a public table
// and reveals nothing about the caller (the scan itself stays client-side).

// Once the index has reached head, re-serve that result briefly instead of
// re-querying the chain. Bounds RPC spend to one catch-up per window no matter
// how often the endpoint is called; a run that stopped short of head is never
// cached, so a caller who needs more progress can always ask for it.
const CAUGHT_UP_TTL_MS = 15_000
let cached: { at: number; result: CatchUpResult } | null = null

export async function POST(): Promise<NextResponse> {
  if (cached && Date.now() - cached.at < CAUGHT_UP_TTL_MS) {
    return NextResponse.json({ data: cached.result })
  }
  try {
    const result = await catchUpAnnouncements()
    cached = result.caughtUp ? { at: Date.now(), result } : null
    return NextResponse.json({ data: result })
  } catch (err) {
    // Detail stays server-side: raw errors here carry database and RPC internals.
    console.error('[stealth/sync] catch-up failed:', err)
    return NextResponse.json({ error: 'Sync failed. Please try again.' }, { status: 502 })
  }
}
