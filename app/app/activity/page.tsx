'use client'

import { useAccount } from 'wagmi'
import { ActivityFeed } from '@/components/activity-feed'
import { InsightsCard } from '@/components/insights-card'

export default function ActivityPage() {
  const { address } = useAccount()
  if (!address) return null

  return (
    <div>
      <h1 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 22, color: 'var(--text)', marginBottom: 4 }}>
        Activity
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 20 }}>
        Every deposit, auto-send, scheduled transfer, and withdrawal on your Split account.
      </p>
      <div className="grid gap-5 lg:grid-cols-[1fr_380px] items-start">
        <ActivityFeed address={address} />
        <InsightsCard address={address} large />
      </div>
    </div>
  )
}
