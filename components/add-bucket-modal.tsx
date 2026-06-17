'use client'

import { useState, useEffect } from 'react'
import { isAddress, decodeEventLog, parseUnits } from 'viem'
import { useWriteContract, useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { getSplitContract, splitAbi, ZERO_ADDRESS } from '@/lib/contracts'
import { publicClient } from '@/lib/arc'
import { pctToBPS } from '@/lib/bps'
import { parseSplitError } from '@/lib/errors'
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

  const [name, setName]       = useState('')
  const [pctStr, setPctStr]   = useState('')
  const [destStr, setDestStr] = useState('')
  const [goalStr, setGoalStr] = useState('')
  const [icon, setIcon]       = useState('wallet')
  const [pending, setPending] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

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

      <div className="relative w-full max-w-md rounded-2xl bg-[var(--split-bg-primary)] shadow-2xl p-6 space-y-5">
        <div>
          <h2 id="add-bucket-title" className="text-base font-semibold text-[var(--split-text-primary)]">
            Add bucket
          </h2>
          <p className="text-sm text-[var(--split-text-secondary)] mt-0.5">
            Define where a share of every deposit goes.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
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
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="bucket-dest">
              Destination address{' '}
              <span className="text-[var(--split-text-tertiary)] font-normal">(optional — leave empty to hold)</span>
            </label>
            <input
              id="bucket-dest"
              type="text"
              placeholder="0x…"
              value={destStr}
              onChange={(e) => setDestStr(e.target.value)}
              className={`${inputCls} font-mono`}
            />
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
              {pending ? 'Adding…' : 'Add bucket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
