'use client'

import { useEffect, useState } from 'react'
import { useWriteContract } from 'wagmi'
import type { SplitBucket } from '@/lib/contracts'
import { getSplitContract, splitAbi } from '@/lib/contracts'
import { publicClient } from '@/lib/arc'
import { parseSplitError } from '@/lib/errors'
import { bpsToPCT } from '@/lib/bps'
import { canAbsorbReduction } from '@/lib/allocation'
import { useScrollLock } from '@/hooks/use-scroll-lock'

// Freeing room for a new bucket without leaving the Add Bucket form.
//
// Buckets must total exactly 100% before a deposit can split, and addBucket
// reverts with ExceedsBPS once the sum would pass 10000. Previously that was only
// discovered on submit, after the whole form had been filled in.
//
// The reduction comes from ONE bucket, deliberately. Split has no batch entrypoint
// (`updateBucket` takes a single bucket id, and the contract does not inherit
// Multicall), so spreading a reduction across N buckets would mean N transactions
// and N wallet confirmations. One bucket keeps it to exactly one signature.

const TX_TIMEOUT_MS = 30_000

interface Props {
  /** Existing buckets, as read from the chain. */
  buckets:    readonly SplitBucket[]
  /** Basis points that must be freed for the pending new bucket to fit. */
  neededBps:  number
  onCancel:   () => void
  /** Fired after the reduction confirms on-chain. */
  onReduced:  () => void
}

export function ReduceAllocationModal({ buckets, neededBps, onCancel, onReduced }: Props) {
  const { writeContractAsync } = useWriteContract()

  const [selectedId, setSelectedId] = useState<bigint | null>(null)
  const [pending, setPending]       = useState(false)
  const [error, setError]           = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onCancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel, pending])

  // Stacks on top of Add Bucket, which has already locked the body. The count
  // makes unmount order irrelevant: scrolling returns only once both are gone.
  useScrollLock()

  // Highest allocation first: the bucket most able to absorb the reduction leads.
  const ordered = [...buckets].filter((b) => b.active).sort((a, b) => b.bps - a.bps)
  const canCover = (b: SplitBucket) => canAbsorbReduction(b.bps, neededBps)
  const eligible = ordered.filter(canCover)
  const selected = ordered.find((b) => b.id === selectedId) ?? null

  async function handleConfirm() {
    if (!selected) return
    setError(null)
    setPending(true)
    try {
      // Name and destination are passed through unchanged: updateBucket rewrites
      // the whole bucket, so omitting them would silently wipe them.
      const hash = await writeContractAsync({
        address:      getSplitContract(),
        abi:          splitAbi,
        functionName: 'updateBucket',
        args:         [selected.id, selected.name, selected.bps - neededBps, selected.destination],
      })
      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
      onReduced()
    } catch (err) {
      setError(parseSplitError(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog" aria-modal="true" aria-labelledby="reduce-title"
    >
      <div aria-hidden="true" className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => { if (!pending) onCancel() }} />

      <div className="relative flex w-full max-w-md max-h-[90dvh] flex-col rounded-2xl bg-[var(--split-bg-primary)] shadow-2xl">
        <div className="shrink-0 p-6 pb-4">
          <h2 id="reduce-title" className="text-base font-semibold text-[var(--split-text-primary)]">
            Free up {bpsToPCT(neededBps)}%
          </h2>
          <p className="mt-0.5 text-sm text-[var(--split-text-secondary)]">
            Your buckets already use 100%. Pick one to reduce so the new bucket fits.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 pb-2">
          {eligible.length === 0 ? (
            <div className="rounded-xl border border-[var(--split-border)] p-4">
              <p className="text-sm text-[var(--split-text-primary)]">
                No single bucket is large enough to free {bpsToPCT(neededBps)}%.
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--split-text-secondary)]">
                Your largest is {ordered[0] ? `${ordered[0].name} at ${bpsToPCT(ordered[0].bps)}%` : 'unavailable'}.
                Either give the new bucket a smaller allocation, or reduce one bucket
                here and run through this again to take the rest from another.
              </p>
            </div>
          ) : (
            ordered.map((b) => {
              const ok       = canCover(b)
              const isPicked = b.id === selectedId
              const after    = b.bps - neededBps
              return (
                <button
                  key={String(b.id)}
                  type="button"
                  disabled={!ok || pending}
                  onClick={() => setSelectedId(b.id)}
                  aria-pressed={isPicked}
                  className={[
                    'flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--split-accent)]',
                    !ok
                      ? 'cursor-not-allowed border-[var(--split-border)] opacity-40'
                      : isPicked
                        ? 'border-[var(--split-accent)] bg-[var(--split-accent)]/10'
                        : 'border-[var(--split-border)] hover:border-[var(--split-text-tertiary)]',
                  ].join(' ')}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-[var(--split-text-primary)]">{b.name}</span>
                    {!ok && (
                      <span className="text-[11px] text-[var(--split-text-tertiary)]">
                        Too small to cover it alone
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums">
                    <span className={ok && isPicked ? 'text-[var(--split-text-tertiary)] line-through' : 'text-[var(--split-text-primary)]'}>
                      {bpsToPCT(b.bps)}%
                    </span>
                    {ok && isPicked && (
                      <span className="ml-2 font-semibold text-[var(--split-accent)]">{bpsToPCT(after)}%</span>
                    )}
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="shrink-0 space-y-3 border-t border-[var(--split-border)] p-6 pt-4">
          {/* The reduction is its own transaction. Confirming it and then closing
              without adding leaves the buckets under 100%, where the contract
              rejects deposits (InvalidBPSTotal). Said plainly, before the click. */}
          <p className="text-[11px] leading-relaxed text-[var(--split-text-tertiary)]">
            This confirms on its own and stays applied. If you stop before adding the
            new bucket, your buckets stay below 100%, and deposits will not split
            until they add back up.
          </p>

          {error && <p role="alert" className="text-sm text-[var(--split-text-danger)]">{error}</p>}

          <div className="flex gap-3">
            <button
              type="button" onClick={onCancel} disabled={pending}
              className="flex-1 rounded-xl border border-[var(--split-border)] px-4 py-2.5 text-sm font-medium text-[var(--split-text-secondary)] transition-colors hover:bg-[var(--split-bg-secondary)] disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button" onClick={handleConfirm} disabled={pending || !selected}
              className="flex-1 rounded-xl bg-[#111110] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85 disabled:opacity-40"
            >
              {pending ? 'Confirming…' : 'Confirm reduction'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

