'use client'

import { useState, useEffect } from 'react'
import { isAddress } from 'viem'
import { useWriteContract, useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { getSplitContract, splitAbi, ZERO_ADDRESS, type SplitBucket } from '@/lib/contracts'
import { publicClient } from '@/lib/arc'
import { pctToBPS, bpsToPCT } from '@/lib/bps'
import { parseSplitError } from '@/lib/errors'
import { IconPicker } from './icon-picker'

interface Props {
  bucket:  SplitBucket
  onClose: () => void
}

const inputCls =
  'w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 text-sm text-[var(--split-text-primary)] placeholder:text-[var(--split-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)] focus:border-transparent transition'

const TX_TIMEOUT_MS = 30_000

export function EditBucketModal({ bucket, onClose }: Props) {
  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  const initialDest = bucket.destination === ZERO_ADDRESS ? '' : bucket.destination

  const [name, setName]       = useState(bucket.name)
  const [pctStr, setPctStr]   = useState(bpsToPCT(bucket.bps).toFixed(2))
  const [destStr, setDestStr] = useState(initialDest)
  const [icon, setIcon]       = useState('wallet')
  const [pending, setPending] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Pre-select the bucket's current icon (best-effort).
  useEffect(() => {
    if (!address) return
    let cancelled = false
    fetch(`/api/bucket-icons?address=${encodeURIComponent(address)}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((j: { data?: Array<{ bucket_id: string; icon: string }> }) => {
        if (cancelled) return
        const row = (j.data ?? []).find((d) => String(d.bucket_id) === String(bucket.id))
        if (row?.icon) setIcon(row.icon)
      })
      .catch(() => { /* default icon is fine */ })
    return () => { cancelled = true }
  }, [address, bucket.id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

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

    const trimmed = destStr.trim()
    const destination: `0x${string}` | null =
      trimmed === '' ? ZERO_ADDRESS
      : isAddress(trimmed) ? (trimmed as `0x${string}`)
      : null

    if (destination === null) {
      setError('Enter a valid destination address, or leave empty to hold funds.')
      return
    }

    setPending(true)
    try {
      const hash = await writeContractAsync({
        address:      getSplitContract(),
        abi:          splitAbi,
        functionName: 'updateBucket',
        args:         [bucket.id, name.trim(), bps, destination],
      })
      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })

      // Persist the icon choice (id is known for an existing bucket).
      if (address) {
        try {
          await fetch('/api/bucket-icons', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body:    JSON.stringify({ address, bucket_id: String(bucket.id), icon }),
          })
        } catch { /* icon is best-effort metadata */ }
      }

      // Non-blocking — a cache error must not prevent the modal closing after a confirmed tx
      void queryClient.invalidateQueries({ queryKey: ['buckets', address] })
      void queryClient.invalidateQueries({ queryKey: ['bucket-icons', address] })
      onClose()
    } catch (err) {
      setError(parseSplitError(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-bucket-title"
    >
      {/* Backdrop — decorative; keyboard users dismiss via Escape */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative w-full max-w-md rounded-2xl bg-[var(--split-bg-primary)] shadow-2xl p-6 space-y-5">
        <div>
          <h2 id="edit-bucket-title" className="text-base font-semibold text-[var(--split-text-primary)]">
            Edit bucket
          </h2>
          <p className="text-sm text-[var(--split-text-secondary)] mt-0.5">
            Changes take effect on the next deposit.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="edit-name">
              Name
            </label>
            <input
              id="edit-name"
              type="text"
              required
              maxLength={32}
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="edit-pct">
              Allocation (%)
            </label>
            <input
              id="edit-pct"
              type="number"
              required
              min="0.01"
              max="100"
              step="0.01"
              value={pctStr}
              onChange={(e) => setPctStr(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="edit-dest">
              Destination address{' '}
              <span className="text-[var(--split-text-tertiary)] font-normal">(leave empty to hold)</span>
            </label>
            <input
              id="edit-dest"
              type="text"
              placeholder="0x…"
              value={destStr}
              onChange={(e) => setDestStr(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]">Icon</label>
            <IconPicker value={icon} onChange={setIcon} />
          </div>

          {error && (
            <p className="text-sm text-[var(--split-text-danger)]" role="alert">{error}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium border border-[var(--split-border)] text-[var(--split-text-secondary)] hover:bg-[var(--split-bg-secondary)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !name.trim() || !pctStr}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-[#111110] hover:opacity-85 transition-opacity disabled:opacity-40"
            >
              {pending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
