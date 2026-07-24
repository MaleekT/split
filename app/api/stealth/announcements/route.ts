import 'server-only'
import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 1000

// GET /api/stealth/announcements?limit=&offset= — public list of ERC-5564
// announcements, oldest first, for CLIENT-SIDE scanning. The client downloads
// pages and filters locally with its viewing key + the view tag; the server
// never learns which announcements belong to whom (Bottleneck 6, Solution A).
export async function GET(req: Request): Promise<NextResponse> {
  const url    = new URL(req.url)
  const limit  = Math.min(Math.max(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)

  const { data, error } = await supabase
    .from('announcements')
    .select('scheme_id, stealth_address, caller, ephemeral_pub_key, metadata, block_number, tx_hash, log_index')
    .order('block_number', { ascending: true })
    .order('log_index', { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = data ?? []
  return NextResponse.json({ data: rows, hasMore: rows.length === limit, nextOffset: offset + rows.length })
}
