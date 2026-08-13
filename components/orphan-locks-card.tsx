'use client'

import { useState, useEffect, useCallback } from 'react'
import { formatUsdc, shortAddress } from '@/lib/format'
import { LockWithdrawModal } from './lock-withdraw-modal'
import type { ClassifiedLock } from '@/hooks/use-bucket-locks'

// Locks that exist but are not attached to any live bucket.
//
// They arise two ways, both ordinary: `createLock` succeeded but `addBucket` did
// not, or a locked bucket was deleted. `Split.deleteBucket` cannot touch a lock,
// so the lock and everything inside it survive under their original conditions.
//
// Without this surface that money would be real, owned, and completely
// unreachable through the app. It is listed here rather than folded into the
// dashboard total on purpose: counting it exactly would require a full
// historical lock scan before any total could render, which is precisely what
// the bounded discovery design avoids. The card says so instead of quietly
// under-reporting.

interface Props {
  loadOrphans: (page?: number) => Promise<ClassifiedLock[]>
  /** Bumped by the parent after any lock action, so the list re-reads. */
  refreshSignal?: number
}

export function OrphanLocksCard({ loadOrphans, refreshSignal = 0 }: Props) {
  const [orphans, setOrphans] = useState<ClassifiedLock[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState<ClassifiedLock | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setOrphans(await loadOrphans(0))
    } catch {
      // Distinguished from "none found": an empty list and a failed read mean
      // very different things when the subject is unreachable money.
      setError('Could not check for unattached locks just now.')
      setOrphans(null)
    } finally {
      setLoading(false)
    }
  }, [loadOrphans])

  useEffect(() => { void load() }, [load, refreshSignal])

  // Render nothing at all in the ordinary case. A permanent empty panel would be
  // noise for the many users who will never have one.
  if (!error && (orphans === null || orphans.length === 0)) return null

  return (
    <section
      aria-labelledby="orphan-locks-title"
      style={{ background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 16, padding: 18, marginTop: 16 }}
    >
      <h2 id="orphan-locks-title" style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
        Locks not attached to a bucket
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.55 }}>
        These are yours and still hold funds, but no bucket routes into them. That
        happens if a bucket was deleted, or if creating one stopped part-way. They
        are <strong style={{ color: 'var(--text)' }}>not counted</strong> in Total in Split.
      </p>

      {error && <p role="alert" style={{ fontSize: 12, color: 'var(--warning, #FBBF24)', marginTop: 10 }}>{error}</p>}

      <ul style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(orphans ?? []).map((o) => (
          <li
            key={o.address}
            className="flex items-center justify-between gap-3"
            style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--bg-3)', border: '0.5px solid var(--border)' }}
          >
            <div style={{ minWidth: 0 }}>
              <p className="font-mono" style={{ fontSize: 12, color: 'var(--text)' }}>{shortAddress(o.address)}</p>
              <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {o.unlockedNow ? 'Unlocked' : 'Still locked · 10% to withdraw early'}
              </p>
            </div>
            <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
              <span className="font-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                {formatUsdc(o.state?.balance ?? 0n)} USDC
              </span>
              <button
                type="button"
                onClick={() => setWithdrawing(o)}
                disabled={(o.state?.balance ?? 0n) === 0n}
                className="transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', background: 'var(--accent-bg)', border: '1px solid var(--accent-border)', borderRadius: 9, padding: '6px 10px' }}
              >
                Withdraw
              </button>
            </div>
          </li>
        ))}
      </ul>

      {loading && <p role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>Checking…</p>}

      {withdrawing?.state && (
        <LockWithdrawModal
          bucketName="this lock"
          lockAddress={withdrawing.address}
          state={withdrawing.state}
          unlockedNow={withdrawing.unlockedNow}
          onClose={() => setWithdrawing(null)}
          onWithdrawn={() => { void load() }}
        />
      )}
    </section>
  )
}
