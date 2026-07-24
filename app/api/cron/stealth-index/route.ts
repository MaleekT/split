import 'server-only'
import { NextResponse } from 'next/server'
import { decodeEventLog, getAddress } from 'viem'
import type { Hex, Log } from 'viem'
import { publicClient } from '@/lib/arc'
import { getAnnouncerContract, announcerAbi } from '@/lib/stealth-contracts'
import { supabase } from '@/lib/supabase'

const MAX_BLOCKS_PER_RUN = 1_000
const CURSOR_KEY = 'stealth'

function authorized(req: Request): boolean {
  if (process.env.SKIP_CRON_AUTH === 'true') return true
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

function safeNum(n: bigint, label: string): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label}: ${n} exceeds MAX_SAFE_INTEGER`)
  return Number(n)
}

interface AnnouncementRow {
  scheme_id:         number
  stealth_address:   string
  caller:            string
  ephemeral_pub_key: string
  metadata:          string
  block_number:      number
  tx_hash:           string
  log_index:         number
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // No-op cleanly until the Announcer is deployed/configured.
  let announcer: `0x${string}`
  try { announcer = getAnnouncerContract() }
  catch { return NextResponse.json({ ok: true, indexed: 0, message: 'announcer not configured' }) }

  const { data: stateRow, error: stateErr } = await supabase
    .from('indexer_state').select('last_block').eq('key', CURSOR_KEY).maybeSingle()
  if (stateErr) return NextResponse.json({ error: `cursor read: ${stateErr.message}` }, { status: 500 })

  const currentBlock = safeNum(await publicClient.getBlockNumber(), 'getBlockNumber')
  const deployBlock  = Number(process.env.STEALTH_DEPLOY_BLOCK ?? 0)
  const storedLast   = (stateRow?.last_block as number | null) ?? 0
  const lastBlock    = storedLast > 0 ? storedLast : (deployBlock > 0 ? deployBlock - 1 : currentBlock - 1)

  if (lastBlock >= currentBlock) return NextResponse.json({ ok: true, indexed: 0, message: 'up to date' })
  const fromBlock = lastBlock + 1
  const toBlock   = Math.min(currentBlock, fromBlock + MAX_BLOCKS_PER_RUN - 1)

  const logs = await publicClient.getLogs({ address: announcer, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) })
  const { rows, decodeErrors } = decodeAnnouncements(logs)

  if (rows.length > 0) {
    const { error } = await supabase
      .from('announcements')
      .upsert(rows, { onConflict: 'tx_hash,log_index', ignoreDuplicates: true })
    if (error) return NextResponse.json({ error: `announcements upsert: ${error.message}` }, { status: 500 })
  }

  const { error: writeErr } = await supabase
    .from('indexer_state').upsert({ key: CURSOR_KEY, last_block: toBlock }, { onConflict: 'key' })
  if (writeErr) return NextResponse.json({ error: `cursor write: ${writeErr.message}` }, { status: 500 })

  return NextResponse.json({ ok: true, from: fromBlock, to: toBlock, logs: logs.length, indexed: rows.length, decodeErrors })
}

function decodeAnnouncements(logs: Log[]): { rows: AnnouncementRow[]; decodeErrors: number } {
  const out: AnnouncementRow[] = []
  let decodeErrors = 0
  for (const log of logs) {
    if (!log.transactionHash) continue
    let decoded
    try {
      decoded = decodeEventLog({ abi: announcerAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
    } catch { decodeErrors++; continue }
    if (decoded.eventName !== 'Announcement') continue
    const args = decoded.args as {
      schemeId: bigint; stealthAddress: `0x${string}`; caller: `0x${string}`
      ephemeralPubKey: `0x${string}`; metadata: `0x${string}`
    }
    out.push({
      scheme_id:         safeNum(args.schemeId, 'schemeId'),
      stealth_address:   getAddress(args.stealthAddress),
      caller:            getAddress(args.caller),
      ephemeral_pub_key: args.ephemeralPubKey,
      metadata:          args.metadata,
      block_number:      safeNum(log.blockNumber ?? 0n, 'blockNumber'),
      tx_hash:           log.transactionHash,
      log_index:         log.logIndex ?? 0,
    })
  }
  return { rows: out, decodeErrors }
}
