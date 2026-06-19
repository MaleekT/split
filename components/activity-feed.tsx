'use client'

import { useQuery } from '@tanstack/react-query'
import { isAddress } from 'viem'
import Link from 'next/link'
import { ArrowDown, ArrowUp, Split } from 'lucide-react'
import { formatUsdc } from '@/lib/format'

interface Breakdown {
  name: string
  amountRaw: string
}

interface ActivityItem {
  id: string
  kind: 'deposit' | 'auto_send' | 'scheduled_send' | 'withdraw'
  incoming: boolean
  title: string
  counterparty?: string
  subtitle?: string
  breakdown?: Breakdown[]
  amountRaw: string
  txHash: string
  timestamp: number
  memoText?: string
}

const PURPLE = '#8B5CF6'
const PURPLE_BG = 'rgba(139, 92, 246, 0.14)'

function friendlyTime(unixSec: number): string {
  if (!unixSec) return ''
  const d = new Date(unixSec * 1000)
  const now = new Date()
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${time}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function breakdownText(breakdown: Breakdown[]): string {
  return 'Split: ' + breakdown.map((b) => `${b.name} $${formatUsdc(BigInt(b.amountRaw))}`).join(' · ')
}

function iconFor(kind: ActivityItem['kind']): { Icon: typeof ArrowDown; color: string; bg: string } {
  if (kind === 'deposit') return { Icon: ArrowDown, color: 'var(--accent)', bg: 'var(--accent-bg)' }
  if (kind === 'withdraw') return { Icon: ArrowUp, color: 'var(--text-2)', bg: 'var(--bg-3)' }
  return { Icon: Split, color: PURPLE, bg: PURPLE_BG }
}

function TxChip({ hash }: { hash: string }) {
  return (
    <a
      href={`https://testnet.arcscan.app/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center font-mono transition-colors hover:text-[var(--accent)]"
      style={{ fontSize: 10, color: 'var(--text-2)', background: 'var(--bg-3)', borderRadius: 6, padding: '2px 6px', marginTop: 4, textDecoration: 'underline', textUnderlineOffset: 2 }}
    >
      Tx: {hash.slice(0, 6)}…{hash.slice(-4)}
    </a>
  )
}

interface Props {
  address: string
  compact?: boolean
}

export function ActivityFeed({ address, compact = false }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['activity', address],
    queryFn: async () => {
      if (!isAddress(address)) throw new Error('Invalid address')
      const res = await fetch(`/api/activity/${encodeURIComponent(address)}`)
      if (!res.ok) throw new Error('Failed to load activity')
      const json = (await res.json()) as { data: ActivityItem[] }
      return json.data
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  })

  const items = compact ? (data ?? []).slice(0, 6) : (data ?? [])

  const card = { background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 14, overflow: 'hidden' as const }

  const header = (
    <div className="flex items-center justify-between" style={{ padding: '14px 18px', borderBottom: '0.5px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)' }} />
        <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>Activity</h2>
      </div>
      {compact && (
        <Link href="/app/activity" style={{ fontSize: 12, color: 'var(--accent)' }} className="hover:opacity-80 transition-opacity">
          View all
        </Link>
      )}
    </div>
  )

  if (isLoading) {
    return (
      <div style={card}>
        {header}
        <div className="p-4 space-y-3">
          {(['a', 'b', 'c', 'd'] as const).map((k, i) => (
            <div key={k} className="h-12 rounded-lg" style={{ background: 'var(--bg-3)', opacity: 1 - i * 0.18 }} />
          ))}
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div style={card}>
        {header}
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: 'var(--text-2)', textAlign: 'center', padding: '40px 16px' }}>
          No activity yet.<br />Make a deposit to get started.
        </p>
      </div>
    )
  }

  return (
    <div style={card}>
      {header}
      <ul className={compact ? 'lg:max-h-[calc(100vh-240px)] lg:overflow-y-auto' : ''} style={{ padding: '8px 18px' }}>
        {items.map((item, idx) => {
          const { Icon, color, bg } = iconFor(item.kind)
          const sub = item.breakdown && item.breakdown.length > 0 ? breakdownText(item.breakdown) : item.subtitle
          const last = idx === items.length - 1
          return (
            <li key={item.id} className="flex gap-3">
              {/* Timeline rail */}
              <div className="flex flex-col items-center">
                <span className="inline-flex items-center justify-center shrink-0" style={{ width: 34, height: 34, borderRadius: 999, background: bg, color }}>
                  <Icon size={16} />
                </span>
                {!last && <span style={{ width: 1, flex: 1, background: 'var(--border)', minHeight: 14 }} />}
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1 flex items-start justify-between gap-3" style={{ paddingBottom: last ? 8 : 16, paddingTop: 4 }}>
                <div className="min-w-0">
                  <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 13, color: 'var(--text)' }}>
                    {item.title}
                    {item.counterparty && (
                      <span className={item.kind === 'deposit' ? '' : 'font-mono'} style={{ color: 'var(--text-2)', fontWeight: 400 }}>
                        {item.kind === 'deposit' ? ' · ' : ' '}{item.counterparty}
                      </span>
                    )}
                  </p>
                  {sub && <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{sub}</p>}
                  {item.memoText && (
                    <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 11, color: 'var(--accent)', fontStyle: 'italic', marginTop: 2 }}>
                      {item.memoText}
                    </p>
                  )}
                  <div><TxChip hash={item.txHash} /></div>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-mono tabular-nums" style={{ fontWeight: 600, fontSize: 13, color: item.incoming ? 'var(--accent)' : 'var(--text-2)' }}>
                    {item.incoming ? '+ ' : '- '}${formatUsdc(BigInt(item.amountRaw))}
                  </p>
                  <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{friendlyTime(item.timestamp)}</p>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
