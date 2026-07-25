import 'server-only'
import { NextResponse } from 'next/server'
import { catchUpAnnouncements } from '@/lib/stealth-index'

// Scheduled ERC-5564 announcement indexing. The catch-up loop lives in
// lib/stealth-index so the on-demand sync (/api/stealth/sync) runs exactly the
// same code path - recipients must never depend on this cron having run, since
// Vercel does not run crons on preview deployments at all.
function authorized(req: Request): boolean {
  if (process.env.SKIP_CRON_AUTH === 'true') return true
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await catchUpAnnouncements())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'stealth index failed' },
      { status: 500 },
    )
  }
}
