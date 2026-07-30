'use client'

import { useState, useEffect, useCallback } from 'react'
import { isAddress, decodeEventLog, parseUnits } from 'viem'
import { useWriteContract, useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { getSplitContract, splitAbi, ZERO_ADDRESS, type SplitBucket } from '@/lib/contracts'
import { useScrollLock } from '@/hooks/use-scroll-lock'
import { ReduceAllocationModal } from './reduce-allocation-modal'
import { bpsToFree } from '@/lib/allocation'
import { publicClient } from '@/lib/arc'
import { pctToBPS } from '@/lib/bps'
import { parseSplitError } from '@/lib/errors'
import { useBucketWallets } from '@/hooks/use-bucket-wallets'
import { IconPicker } from './icon-picker'

interface Props {
  onClose: () => void
}

const inputCls =
  'w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 text-sm text-[var(--split-text-primary)] placeholder:text-[var(--split-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)] focus:border-transparent transition'

const TX_TIMEOUT_MS = 30_000

export function AddBucketModal({ onClose }: Props) {
  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  const bucketWallets = useBucketWallets()

  const [name, setName]       = useState('')
  const [pctStr, setPctStr]   = useState('')
  const [destStr, setDestStr] = useState('')
  const [goalStr, setGoalStr] = useState('')
  const [icon, setIcon]       = useState('wallet')
  const [pending, setPending] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  // 'hold' keeps funds in the contract (destination 0x0, the existing default),
  // 'manual' is the existing paste-an-address path, 'generated' has Split derive
  // a wallet it can also spend from.
  const [destMode, setDestMode] = useState<'hold' | 'manual' | 'generated'>('hold')
  const [status, setStatus]     = useState<string | null>(null)

  // Existing buckets, so the allocation can be checked against the 100% ceiling
  // BEFORE submitting rather than discovering ExceedsBPS after the form is filled.
  const [existingBuckets, setExistingBuckets] = useState<readonly SplitBucket[]>([])
  const [reduceOpen, setReduceOpen] = useState(false)

  const loadBuckets = useCallback(async () => {
    if (!address) return
    try {
      const rows = await publicClient.readContract({
        address: getSplitContract(), abi: splitAbi, functionName: 'getBuckets', args: [address],
      }) as readonly SplitBucket[]
      setExistingBuckets(rows)
    } catch {
      // Non-fatal: without this the ceiling check is skipped and the contract
      // still rejects an over-allocation, just later and less helpfully.
    }
  }, [address])

  useEffect(() => { void loadBuckets() }, [loadBuckets])

  const currentTotalBps = existingBuckets
    .filter((b) => b.active)
    .reduce((sum, b) => sum + b.bps, 0)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Stops the dashboard scrolling behind the dialog, which otherwise moves the
  // page out from under the user mid-form. Counted, because the allocation
  // reducer stacks on top of this one.
  useScrollLock()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Generating needs the connected address to read existing destinations and to
    // own the reservation, so check before doing any work rather than asserting.
    if (destMode === 'generated' && !address) {
      setError('Connect your wallet to generate an address for this bucket.')
      return
    }

    const pct = parseFloat(pctStr)
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      setError('Allocation must be between 0.01% and 100%.')
      return
    }
    const bps = pctToBPS(pct)
    if (bps <= 0 || bps > 10_000) {
      setError('Allocation must be between 0.01% and 100%.')
      return
    }

    // Buckets must total exactly 100%, so an over-allocation would revert with
    // ExceedsBPS on submit. Offer to free the room here instead of sending the
    // user away to edit another bucket and re-enter this whole form.
    if (currentTotalBps + bps > 10_000) {
      setReduceOpen(true)
      return
    }

    const trimmed = destStr.trim()
    let destination: `0x${string}` | null =
      destMode === 'hold' ? ZERO_ADDRESS
      : destMode === 'manual' && isAddress(trimmed) ? (trimmed as `0x${string}`)
      : destMode === 'generated' ? ZERO_ADDRESS  // replaced below, once derived
      : null

    if (destination === null) {
      setError('Enter a valid destination address, or choose another option.')
      return
    }

    if (goalStr.trim()) {
      try {
        const g = parseUnits(goalStr.trim(), 6)
        if (g <= 0n) throw new Error()
      } catch {
        setError('Goal must be a valid positive number, e.g. 100 or 250.50.')
        return
      }
    }

    setPending(true)
    try {
      // Derive and reserve BEFORE the on-chain call, because addBucket takes the
      // destination as an argument. The bucket id does not exist yet, so the
      // reservation is bound to it after the receipt confirms.
      let generatedWallet: `0x${string}` | null = null
      if (destMode === 'generated') {
        setStatus('Deriving your wallet…')
        try {
          const existing = await publicClient.readContract({
            address: getSplitContract(), abi: splitAbi, functionName: 'getBuckets', args: [address!],
          }) as readonly { destination: `0x${string}` }[]
          const allocated = await bucketWallets.allocateAndReserve(existing.map((b) => b.destination))
          generatedWallet = allocated.walletAddress
          destination = allocated.walletAddress
        } catch (err) {
          // Surfaced directly rather than through parseSplitError, which only
          // understands Solidity custom errors and turns everything else into
          // "Something went wrong" - hiding the actual cause. Nothing has been
          // sent on-chain at this point, so there is nothing to unwind.
          setError(err instanceof Error ? err.message : 'Could not prepare a generated wallet')
          setPending(false)
          setStatus(null)
          return
        }
      }

      setStatus('Confirm in your wallet…')
      const hash = await writeContractAsync({
        address:      getSplitContract(),
        abi:          splitAbi,
        functionName: 'addBucket',
        args:         [name.trim(), bps, destination],
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })

      // Persist the chosen icon against the new bucket id, read from the BucketAdded event.
      if (address) {
        let newId: bigint | null = null
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: splitAbi, data: log.data, topics: log.topics })
            if (decoded.eventName === 'BucketAdded') { newId = decoded.args.bucketId as bigint; break }
          } catch { /* not a Split event */ }
        }
        if (newId !== null) {
          // Attach the reservation now the bucket id exists. Best-effort by
          // design: if this fails the bucket still works and still spends,
          // because recovery resolves the wallet by scanning indices against
          // on-chain destinations. Only the badge would be missing.
          if (generatedWallet) {
            try {
              await bucketWallets.bind(generatedWallet, Number(newId))
            } catch { /* recovery covers this; never block bucket creation on it */ }
          }

          try {
            await fetch('/api/bucket-icons', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
              body:    JSON.stringify({ address, bucket_id: String(newId), icon }),
            })
          } catch { /* icon is best-effort metadata */ }

          if (goalStr.trim()) {
            try {
              const targetAmount = parseUnits(goalStr.trim(), 6)
              if (targetAmount > 0n) {
                await fetch('/api/goals', {
                  method:  'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                  body:    JSON.stringify({ address, bucket_id: String(newId), target_amount: String(targetAmount) }),
                })
              }
            } catch { /* goal is best-effort metadata */ }
          }
        }
      }

      void queryClient.invalidateQueries({ queryKey: ['buckets', address] })
      void queryClient.invalidateQueries({ queryKey: ['bucket-icons', address] })
      onClose()
    } catch (err) {
      setError(parseSplitError(err))
    } finally {
      setPending(false)
      setStatus(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-bucket-title"
    >
      <div aria-hidden="true" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />

      {/* Capped to the viewport with the title and action row pinned, so the form
          can grow without pushing "Add bucket" off-screen where it cannot be
          reached. dvh rather than vh: vh ignores mobile browser chrome and would
          still clip the footer on a phone. */}
      <div className="relative flex w-full max-w-md max-h-[90dvh] flex-col rounded-2xl bg-[var(--split-bg-primary)] shadow-2xl">
        <div className="shrink-0 p-6 pb-4">
          <h2 id="add-bucket-title" className="text-base font-semibold text-[var(--split-text-primary)]">
            Add bucket
          </h2>
          <p className="text-sm text-[var(--split-text-secondary)] mt-0.5">
            Define where a share of every deposit goes.
          </p>
        </div>

        {/* min-h-0 is load-bearing: without it the flex child refuses to shrink
            below its content height and the body never scrolls. */}
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="bucket-name">
              Name
            </label>
            <input
              id="bucket-name"
              type="text"
              required
              maxLength={32}
              autoFocus
              placeholder="e.g. Savings"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="bucket-pct">
              Allocation (%)
            </label>
            <input
              id="bucket-pct"
              type="number"
              required
              min="0.01"
              max="100"
              step="0.01"
              placeholder="e.g. 30"
              value={pctStr}
              onChange={(e) => setPctStr(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-[var(--split-text-secondary)]">Where this bucket sends</span>
            <div role="radiogroup" aria-label="Where this bucket sends" className="grid grid-cols-3 gap-1.5">
              {([
                ['hold',      'Hold in Split'],
                ['manual',    'I have a wallet'],
                ['generated', 'Generate one'],
              ] as const).map(([mode, label]) => {
                const selected = destMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => { setDestMode(mode); setError(null) }}
                    className={[
                      'rounded-xl border px-2 py-2 text-xs font-medium transition',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--split-accent)]',
                      selected
                        ? 'border-[var(--split-accent)] bg-[var(--split-accent)]/10 text-[var(--split-text-primary)]'
                        : 'border-[var(--split-border)] bg-[var(--split-bg-secondary)] text-[var(--split-text-secondary)] hover:border-[var(--split-text-tertiary)]',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                )
              })}
            </div>

            {destMode === 'manual' && (
              <input
                id="bucket-dest"
                type="text"
                placeholder="0x…"
                aria-label="Destination address"
                value={destStr}
                onChange={(e) => setDestStr(e.target.value)}
                className={`${inputCls} font-mono mt-1.5`}
              />
            )}

            {destMode === 'hold' && (
              <p className="text-[11px] leading-relaxed text-[var(--split-text-tertiary)]">
                Funds stay inside the Split contract until you withdraw them.
              </p>
            )}

            {destMode === 'generated' && (
              <p className="text-[11px] leading-relaxed text-[var(--split-text-tertiary)]">
                Split creates an address for this bucket and can send from it directly, so
                paying out takes no separate wallet step. That also means Split can sign for
                it, so it does not carry the independent confirmation a standalone wallet app
                would give you. You can recreate it on any device by signing again.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="bucket-goal">
              Savings goal{' '}
              <span className="text-[var(--split-text-tertiary)] font-normal">(optional — USDC target to track progress)</span>
            </label>
            <div className="relative">
              <input
                id="bucket-goal"
                type="number"
                min="0.000001"
                step="0.000001"
                placeholder="0.00"
                value={goalStr}
                onChange={(e) => setGoalStr(e.target.value)}
                className={`${inputCls} font-mono pr-16`}
              />
              <span
                aria-hidden="true"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-[var(--split-text-tertiary)] font-mono select-none"
              >
                USDC
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]">Icon</label>
            <IconPicker value={icon} onChange={setIcon} />
          </div>

          </div>

          {/* Pinned: the error sits here rather than in the scroll area so a
              failure can never be scrolled out of view, which is how the last one
              went unnoticed. */}
          <div className="shrink-0 space-y-3 border-t border-[var(--split-border)] p-6 pt-4">
            {error && (
              <p className="text-sm text-[var(--split-text-danger)]" role="alert">{error}</p>
            )}

            <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium border border-[var(--split-border)] text-[var(--split-text-secondary)] hover:bg-[var(--split-bg-secondary)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                pending || !name.trim() || !pctStr ||
                // Manual needs a valid address, and generating needs a connected
                // wallet to own the reservation. Blocked here rather than failing
                // after the user has already committed to submitting.
                (destMode === 'manual' && !isAddress(destStr.trim())) ||
                (destMode === 'generated' && !address)
              }
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-[#111110] hover:opacity-85 transition-opacity disabled:opacity-40"
            >
              {pending ? (status ?? 'Adding…') : 'Add bucket'}
            </button>
            </div>
          </div>
        </form>
      </div>

      {/* neededBps is in basis points, not percent: pctToBPS runs first, or a 15%
          bucket would ask to free 15 bps (0.15%) and the reduction would be
          nonsense. */}
      {reduceOpen && (
        <ReduceAllocationModal
          buckets={existingBuckets}
          neededBps={bpsToFree(currentTotalBps, pctToBPS(parseFloat(pctStr) || 0))}
          onCancel={() => setReduceOpen(false)}
          onReduced={async () => {
            // Re-read from chain so the ceiling check sees the new total; the user
            // then presses Add themselves, as a second deliberate action.
            await loadBuckets()
            void queryClient.invalidateQueries({ queryKey: ['buckets', address] })
            setReduceOpen(false)
          }}
        />
      )}
    </div>
  )
}
