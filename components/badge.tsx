'use client'

import { Zap } from 'lucide-react'

export type BadgeVariant = 'auto-sends' | 'holds' | 'goal'

export function Badge({ variant }: { variant: BadgeVariant }) {
  if (variant === 'auto-sends') {
    return (
      <span className="badge" style={{ background: 'var(--accent-bg)', color: 'var(--accent)', gap: 4 }}>
        <Zap size={9} strokeWidth={2.5} />
        Auto-sends
      </span>
    )
  }
  if (variant === 'holds') {
    return (
      <span className="badge" style={{ background: 'var(--bg-3)', color: 'var(--text-2)' }}>
        Holds
      </span>
    )
  }
  return (
    <span className="badge" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>
      ◎ Goal
    </span>
  )
}
