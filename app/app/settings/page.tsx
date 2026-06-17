'use client'

import { useState, useEffect, useRef } from 'react'
import { useAccount, useReadContract, useWriteContract } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { getSplitContract, splitAbi, ZERO_ADDRESS, type SplitBucket } from '@/lib/contracts'
import { publicClient } from '@/lib/arc'
import { parseSplitError } from '@/lib/errors'
import { useRoutedTotals } from '@/hooks/use-routed-totals'
import { useBucketIcons } from '@/hooks/use-bucket-icons'
import { BucketCard } from '@/components/bucket-card'
import { BpsIndicator } from '@/components/bps-indicator'
import { AddBucketModal } from '@/components/add-bucket-modal'
import { EditBucketModal } from '@/components/edit-bucket-modal'
import { WithdrawModal } from '@/components/withdraw-modal'
import { ScheduleModal } from '@/components/schedule-modal'
import { GoalModal } from '@/components/goal-modal'

const TX_TIMEOUT_MS = 30_000

type ModalState =
  | { kind: 'add' }
  | { kind: 'edit';     bucket: SplitBucket }
  | { kind: 'withdraw'; bucket: SplitBucket }
  | { kind: 'schedule'; bucket: SplitBucket }
  | { kind: 'goal';     bucket: SplitBucket }
  | null

export default function SettingsPage() {
  const { address } = useAccount()
  const queryClient = useQueryClient()
  const { writeContractAsync } = useWriteContract()
  const contractAddress = getSplitContract()
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  // ZERO_ADDRESS is a safe fallback — query is disabled when address is undefined
  const safeAddress = address ?? ZERO_ADDRESS

  const { data: rawBuckets, isLoading, refetch } = useReadContract({
    address:      contractAddress,
    abi:          splitAbi,
    functionName: 'getBuckets',
    args:         [safeAddress],
    query:        { enabled: !!address },
  })

  const buckets = (rawBuckets ?? []) as SplitBucket[]

  const { data: routedTotals } = useRoutedTotals(address)
  const { data: bucketIcons } = useBucketIcons(address)

  // Goals: keyed by bucket id string → target amount bigint
  const [goals, setGoals] = useState<Record<string, bigint>>({})

  useEffect(() => {
    if (!address) return
    const load = async () => {
      try {
        const r = await fetch(`/api/goals?address=${encodeURIComponent(address)}`)
        if (!mounted.current) return        // unmounted before response arrived
        if (!r.ok) return                   // non-2xx — ignore; goals display is best-effort
        const body = await r.json() as { data?: Array<{ bucket_id: string; target_amount: string }> }
        if (!mounted.current) return        // unmounted during JSON parse
        const map: Record<string, bigint> = {}
        for (const g of body.data ?? []) {
          try {
            // Normalize through BigInt so key always matches String(b.id) lookups
            const key = String(BigInt(g.bucket_id))
            const amt = BigInt(g.target_amount)
            if (amt > 0n) map[key] = amt
          } catch { /* skip malformed row */ }
        }
        setGoals(map)
      } catch { /* non-critical — goals display is best-effort */ }
    }
    void load()
  }, [address])

  function handleGoalSaved(bucketId: string, newGoal: bigint) {
    setGoals((prev) => {
      // Immutable update — spread then set or remove the key
      const { [bucketId]: _removed, ...rest } = prev
      return newGoal > 0n ? { ...rest, [bucketId]: newGoal } : rest
    })
  }

  const [modal, setModal]                = useState<ModalState>(null)
  const [pendingDelete, setPendingDelete] = useState<SplitBucket | null>(null)
  const [deleting, setDeleting]          = useState<bigint | null>(null)
  const [deleteError, setDeleteError]    = useState<string | null>(null)

  function closeModal() {
    setModal(null)
    void refetch()
  }

  async function confirmDelete(bucket: SplitBucket) {
    setPendingDelete(null)
    setDeleteError(null)
    setDeleting(bucket.id)
    try {
      const hash = await writeContractAsync({
        address:      contractAddress,
        abi:          splitAbi,
        functionName: 'deleteBucket',
        args:         [bucket.id],
      })
      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
      if (address) void queryClient.invalidateQueries({ queryKey: ['buckets', address] })
      void refetch()
    } catch (err) {
      let message = 'Delete failed. Please try again.'
      try { message = parseSplitError(err) } catch { /* parseSplitError is safe; guard is defensive */ }
      if (mounted.current) setDeleteError(message)
    } finally {
      if (mounted.current) setDeleting(null)
    }
  }

  if (!address) return null

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 700, fontSize: 22, color: 'var(--text)', marginBottom: 4 }}>Buckets</h1>
          <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
            Define how every deposit is split.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModal({ kind: 'add' })}
          disabled={buckets.length >= 10}
          title={buckets.length >= 10 ? 'Maximum of 10 buckets reached' : undefined}
          className="shrink-0 inline-flex items-center gap-1 px-4 py-2 rounded-xl text-sm font-semibold font-sans text-[var(--accent)] bg-[var(--accent-bg)] border-[0.5px] border-[var(--accent)] hover:shadow-[0_0_0_2px_var(--accent)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + Add bucket
        </button>
      </div>

      {/* ── BPS allocation indicator ── */}
      {buckets.length > 0 && (
        <div style={{ background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 14, padding: '14px 20px' }}>
          <BpsIndicator buckets={buckets} />
        </div>
      )}

      {deleteError && (
        <p className="text-sm text-[var(--split-text-danger)]" role="alert">{deleteError}</p>
      )}

      {/* ── Bucket list ── */}
      {isLoading ? (
        <div className="space-y-4">
          {(['skel-a', 'skel-b', 'skel-c'] as const).map((k) => (
            <div key={k} className="h-44 rounded-2xl bg-[var(--split-bg-secondary)] animate-pulse" />
          ))}
        </div>
      ) : buckets.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--split-border)] p-12 text-center">
          <p className="text-sm font-medium text-[var(--split-text-primary)]">No buckets yet</p>
          <p className="text-sm text-[var(--split-text-secondary)] mt-1 max-w-xs mx-auto">
            Add a bucket to define where a share of every deposit goes.
          </p>
          <button
            type="button"
            onClick={() => setModal({ kind: 'add' })}
            className="mt-4 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-[#111110] hover:opacity-85 transition-opacity"
          >
            Add first bucket
          </button>
        </div>
      ) : (
        <div className="bucket-grid">
          {buckets.map((b) => {
            const rawRouted = routedTotals?.[String(b.id)]
            return (
            <div key={String(b.id)} className="relative">
              {/* Deleting spinner overlay */}
              {deleting === b.id && (
                <div className="absolute inset-0 z-10 rounded-2xl bg-white/70 backdrop-blur-[1px] flex items-center justify-center">
                  <span className="text-xs text-[var(--split-text-secondary)]">Deleting…</span>
                </div>
              )}

              {/* Inline delete confirmation overlay — avoids window.confirm */}
              {pendingDelete?.id === b.id && (
                <div className="absolute inset-0 z-10 rounded-2xl bg-[var(--split-bg-primary)]/95 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3 p-5 border border-[var(--split-text-danger)]/20">
                  <p className="text-sm font-semibold text-[var(--split-text-primary)] text-center">
                    Delete this bucket?
                  </p>
                  <p className="text-xs text-[var(--split-text-secondary)] text-center">
                    Any remaining balance can still be withdrawn.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPendingDelete(null)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--split-border)] text-[var(--split-text-secondary)] hover:bg-[var(--split-bg-secondary)] transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void confirmDelete(pendingDelete)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-[var(--split-text-danger)] hover:opacity-85 transition-opacity"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}

              <BucketCard
                bucket={b}
                goal={goals[String(b.id)]}
                routedTotal={rawRouted ? BigInt(rawRouted) : 0n}
                iconSlug={bucketIcons?.[String(b.id)]}
                onEdit={() => setModal({ kind: 'edit', bucket: b })}
                onWithdraw={() => setModal({ kind: 'withdraw', bucket: b })}
                onSchedule={() => setModal({ kind: 'schedule', bucket: b })}
                onSetGoal={() => setModal({ kind: 'goal', bucket: b })}
                onDelete={() => setPendingDelete(b)}
              />
            </div>
            )
          })}
        </div>
      )}

      {modal?.kind === 'add'      && <AddBucketModal onClose={closeModal} />}
      {modal?.kind === 'edit'     && <EditBucketModal bucket={modal.bucket} onClose={closeModal} />}
      {modal?.kind === 'withdraw' && <WithdrawModal   bucket={modal.bucket} onClose={closeModal} />}
      {modal?.kind === 'schedule' && <ScheduleModal   bucket={modal.bucket} onClose={closeModal} />}
      {modal?.kind === 'goal'     && (
        <GoalModal
          bucket={modal.bucket}
          currentGoal={goals[String(modal.bucket.id)]}
          onClose={() => setModal(null)}
          onSaved={handleGoalSaved}
        />
      )}
    </div>
  )
}
