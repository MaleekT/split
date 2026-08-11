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
        {/* Same fix as the dashboard: the sticky offset is measured from inside
            <main>'s own 24px padding, so `top-6` pushed this card 24px below the
            Activity feed beside it even at the top of the page. */}
        <div className="lg:sticky lg:top-0 lg:self-start">
          <InsightsCard address={address} large />
        </div>
      </div>
    </div>
  )
}
