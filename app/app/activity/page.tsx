'use client'

import { useAccount } from 'wagmi'
import { ActivityFeed } from '@/components/activity-feed'

export default function ActivityPage() {
  const { address } = useAccount()
  if (!address) return null

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 22, color: 'var(--text)', marginBottom: 4 }}>
        Activity
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 20 }}>
        Every deposit, auto-send, scheduled transfer, and withdrawal on your Split account.
      </p>
      <ActivityFeed address={address} />
    </div>
  )
}
