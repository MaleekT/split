'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { parseUnits, isAddress } from 'viem'
import { useWriteContract, useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { getSplitContract, splitAbi, type SplitBucket } from '@/lib/contracts'
import { publicClient } from '@/lib/arc'
import { parseSplitError } from '@/lib/errors'
import { formatUsdc, shortAddress } from '@/lib/format'

interface Props {
  bucket:  SplitBucket
  onClose: () => void
}

const inputCls =
  'w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 text-sm text-[var(--split-text-primary)] placeholder:text-[var(--split-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)] focus:border-transparent transition'

const TX_TIMEOUT_MS       = 30_000
const MIN_INTERVAL_SECONDS = 86_400

const PRESETS = [
  { label: 'Daily',   seconds: 86_400 },
  { label: 'Weekly',  seconds: 604_800 },
  { label: 'Monthly', seconds: 2_592_000 },
] as const

interface Confirmed {
  rawAmount:     bigint
  intervalSec:   number
  destination:   `0x${string}`
  amountDisplay: string
  intervalLabel: string
}

export function ScheduleModal({ bucket, onClose }: Props) {
  if (!bucket) return null

  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const modalRef = useRef<HTMLDivElement>(null)

  const [amountStr, setAmountStr]     = useState('')
  const [intervalSec, setIntervalSec] = useState<number>(PRESETS[0].seconds)
  const [destStr, setDestStr]       = useState('')
  const [confirmed, setConfirmed]   = useState<Confirmed | null>(null)
  const [pending, setPending]       = useState(false)
  const [error, setError]           = useState<string | null>(null)

  // Escape closes confirm step first, then the modal
  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (confirmed) { setConfirmed(null); return }
      onClose()
    },
    [confirmed, onClose],
  )

  // Escape + focus trap
  useEffect(() => {
    const trapFocus = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !modalRef.current) return
      const els = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled])',
        ),
      )
      if (els.length === 0) return
      // Non-null safe after length guard; noUncheckedIndexedAccess requires explicit assertion
      const first = els[0]!
      const last  = els[els.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        last.focus(); e.preventDefault()
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus(); e.preventDefault()
      }
    }
    document.addEventListener('keydown', handleEscape)
    document.addEventListener('keydown', trapFocus)
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('keydown', trapFocus)
    }
  }, [handleEscape])

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    let rawAmount: bigint
    try {
      rawAmount = parseUnits(amountStr.trim(), 6)
    } catch {
      setError('Invalid amount — enter a number like 10 or 10.50.')
      return
    }
    if (rawAmount === 0n) {
      setError('Amount must be greater than zero.')
      return
    }
    if (!Number.isInteger(intervalSec) || intervalSec < MIN_INTERVAL_SECONDS) {
      setError(`Minimum interval is 1 day.`)
      return
    }
    if (!isAddress(destStr.trim())) {
      setError('A valid destination address is required.')
      return
    }

    const preset = PRESETS.find((p) => p.seconds === intervalSec)
    setConfirmed({
      rawAmount,
      intervalSec,
      destination:   destStr.trim() as `0x${string}`,
      amountDisplay: formatUsdc(rawAmount),
      intervalLabel: preset?.label ?? `Every ${intervalSec}s`,
    })
  }

  async function handleConfirm() {
    if (!confirmed) return
    setPending(true)
    setError(null)
    try {
      const hash = await writeContractAsync({
        address:      getSplitContract(),
        abi:          splitAbi,
        functionName: 'setScheduledSend',
        args:         [
          bucket.id,
          confirmed.rawAmount,
          BigInt(confirmed.intervalSec),
          confirmed.destination,
        ],
      })
      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
      // Invalidate by prefix — address may be undefined during the call
      void queryClient.invalidateQueries({ queryKey: ['buckets'] })
      onClose()
    } catch (err) {
      setError(parseSplitError(err))
      setConfirmed(null)
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-title"
    >
      <div aria-hidden="true" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />

      <div ref={modalRef} className="relative w-full max-w-md rounded-2xl bg-[var(--split-bg-primary)] shadow-2xl p-6 space-y-5">
        <div>
          <h2 id="schedule-title" className="text-base font-semibold text-[var(--split-text-primary)]">
            {confirmed ? 'Confirm schedule' : `Schedule send — ${bucket.name}`}
          </h2>
          <p className="text-sm text-[var(--split-text-secondary)] mt-0.5">
            {confirmed
              ? 'Review the details before authorising the transaction.'
              : 'Sends a fixed amount on a recurring interval.'}
          </p>
        </div>

        {/* ── Confirmation view ── */}
        {confirmed ? (
          <div className="space-y-4">
            <dl className="space-y-3 rounded-xl bg-[var(--split-bg-secondary)] p-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-[var(--split-text-secondary)]">Amount</dt>
                <dd className="font-mono font-semibold tabular-nums">{confirmed.amountDisplay} USDC</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--split-text-secondary)]">Interval</dt>
                <dd className="font-medium">{confirmed.intervalLabel}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--split-text-secondary)]">Destination</dt>
                <dd className="font-mono">{shortAddress(confirmed.destination)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--split-text-secondary)]">From bucket</dt>
                <dd className="font-medium">{bucket.name}</dd>
              </div>
            </dl>

            {error && <p className="text-sm text-[var(--split-text-danger)]" role="alert">{error}</p>}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setConfirmed(null)}
                disabled={pending}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium border border-[var(--split-border)] text-[var(--split-text-secondary)] hover:bg-[var(--split-bg-secondary)] transition-colors disabled:opacity-40"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={pending}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-[var(--split-accent)] hover:opacity-85 transition-opacity disabled:opacity-40"
              >
                {pending ? 'Scheduling…' : 'Confirm & schedule'}
              </button>
            </div>
          </div>
        ) : (
        /* ── Form view ── */
          <form onSubmit={handleFormSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="sched-amount">
                Amount per send (USDC)
              </label>
              <input
                id="sched-amount"
                type="number"
                required
                min="0.000001"
                step="0.000001"
                placeholder="0.00"
                autoFocus
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-[var(--split-text-secondary)]">Interval</p>
              <div className="flex gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setIntervalSec(p.seconds)}
                    className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-colors ${
                      intervalSec === p.seconds
                        ? 'border-[var(--split-accent)] bg-[var(--split-accent-light)] text-[var(--split-accent)]'
                        : 'border-[var(--split-border)] text-[var(--split-text-secondary)] hover:bg-[var(--split-bg-secondary)]'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="sched-dest">
                Destination address
              </label>
              <input
                id="sched-dest"
                type="text"
                required
                placeholder="0x…"
                value={destStr}
                onChange={(e) => setDestStr(e.target.value)}
                className={`${inputCls} font-mono`}
              />
            </div>

            {error && <p className="text-sm text-[var(--split-text-danger)]" role="alert">{error}</p>}

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
                disabled={!amountStr || !destStr}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-[#111110] hover:opacity-85 transition-opacity disabled:opacity-40"
              >
                Review
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
