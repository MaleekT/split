'use client'

import { useState, useEffect } from 'react'
import { parseUnits, isAddress } from 'viem'
import { useWriteContract, useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { getSplitContract, splitAbi, type SplitBucket } from '@/lib/contracts'
import { publicClient } from '@/lib/arc'
import { parseSplitError } from '@/lib/errors'
import { UsdcAmount } from './usdc-amount'

interface Props {
  bucket:  SplitBucket
  onClose: () => void
}

const inputCls =
  'w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 text-sm text-[var(--split-text-primary)] placeholder:text-[var(--split-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)] focus:border-transparent transition font-mono'

const TX_TIMEOUT_MS = 30_000

export function WithdrawModal({ bucket, onClose }: Props) {
  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  const [amountStr, setAmountStr] = useState('')
  const [toStr, setToStr]         = useState('')
  const [pending, setPending]     = useState(false)
  const [error, setError]         = useState<string | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const parsed = parseFloat(amountStr)
    if (isNaN(parsed) || parsed <= 0) {
      setError('Enter a valid amount greater than zero.')
      return
    }

    let rawAmount: bigint
    try {
      rawAmount = parseUnits(amountStr.trim(), 6)
    } catch {
      setError('Invalid amount — enter a number like 10 or 10.50.')
      return
    }

    if (rawAmount > bucket.balance) {
      setError('Amount exceeds bucket balance.')
      return
    }

    const trimmedTo = toStr.trim()
    if (trimmedTo !== '' && !isAddress(trimmedTo)) {
      setError('Enter a valid destination address or leave empty to withdraw to your wallet.')
      return
    }

    setPending(true)
    try {
      const contractAddress = getSplitContract()
      const hash = trimmedTo === '' || !address
        ? await writeContractAsync({
            address:      contractAddress,
            abi:          splitAbi,
            functionName: 'withdraw',
            args:         [bucket.id, rawAmount as unknown as bigint],
          })
        : await writeContractAsync({
            address:      contractAddress,
            abi:          splitAbi,
            functionName: 'withdrawTo',
            args:         [bucket.id, rawAmount as unknown as bigint, trimmedTo as `0x${string}`],
          })

      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
      void queryClient.invalidateQueries({ queryKey: ['buckets', address] })
      void queryClient.invalidateQueries({ queryKey: ['activity', address] })
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
      aria-labelledby="withdraw-title"
    >
      <div aria-hidden="true" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative w-full max-w-md rounded-2xl bg-[var(--split-bg-primary)] shadow-2xl p-6 space-y-5">
        <div>
          <h2 id="withdraw-title" className="text-base font-semibold text-[var(--split-text-primary)]">
            Withdraw from {bucket.name}
          </h2>
          <p className="text-sm text-[var(--split-text-secondary)] mt-0.5">
            Available:{' '}
            <UsdcAmount value={bucket.balance} className="font-semibold text-[var(--split-text-primary)]" />
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="withdraw-amount">
              Amount (USDC)
            </label>
            <input
              id="withdraw-amount"
              type="number"
              required
              min="0.000001"
              step="0.000001"
              placeholder="0.00"
              autoFocus
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              className={inputCls}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="withdraw-to">
              Send to{' '}
              <span className="text-[var(--split-text-tertiary)] font-normal">(leave empty to use your wallet)</span>
            </label>
            <input
              id="withdraw-to"
              type="text"
              placeholder="0x…"
              value={toStr}
              onChange={(e) => setToStr(e.target.value)}
              className={inputCls}
            />
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
              disabled={pending || !amountStr}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-[#111110] hover:opacity-85 transition-opacity disabled:opacity-40"
            >
              {pending ? 'Withdrawing…' : 'Withdraw'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
